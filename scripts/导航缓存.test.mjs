import test from 'node:test';
import assert from 'node:assert/strict';
import { createNavigationCache, navigationCache, NAVIGATION_CACHE_TTL_MS } from '../src/server/navigation-cache.ts';
import { createMySqlSubmissionRepository } from '../src/server/mysql-submissions.ts';

const deferred = () => Promise.withResolvers();

test('冷读取、热命中和 TTL 到期边界', async () => {
  let time = 0;
  let calls = 0;
  const cache = createNavigationCache(NAVIGATION_CACHE_TTL_MS, () => time);
  const load = async () => ({ version: ++calls });
  const first = await cache.get(load);
  time = 29_999;
  assert.strictEqual(await cache.get(load), first);
  assert.equal(calls, 1);
  time = 30_000;
  assert.deepEqual(await cache.get(load), { version: 2 });
});

test('冷启动与到期后的并发请求均 single flight', async () => {
  let time = 0;
  let calls = 0;
  const cache = createNavigationCache(30, () => time);
  for (const version of [1, 2]) {
    const gate = deferred();
    const load = () => { calls++; return gate.promise; };
    const requests = Array.from({ length: 25 }, () => cache.get(load));
    assert.ok(requests.every(request => request === requests[0]));
    await Promise.resolve();
    assert.equal(calls, version);
    gate.resolve(version);
    assert.deepEqual(await Promise.all(requests), Array(25).fill(version));
    time += 30;
  }
});

test('失败共享异常但不缓存，过期刷新失败不返回旧数据', async () => {
  let time = 0;
  const cache = createNavigationCache(30, () => time);
  await cache.get(async () => 'old');
  time = 30;
  const error = new Error('database unavailable');
  let calls = 0;
  const fail = () => { calls++; throw error; };
  const results = await Promise.allSettled([cache.get(fail), cache.get(fail)]);
  assert.equal(calls, 1);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason === error));
  await assert.rejects(cache.get(async () => { throw error; }), error);
  assert.equal(await cache.get(async () => 'recovered'), 'recovered');
});

test('慢读取不从完成时间续期', async () => {
  let time = 0;
  const cache = createNavigationCache(30, () => time);
  const gate = deferred();
  const request = cache.get(() => gate.promise);
  time = 31;
  gate.resolve('old');
  assert.equal(await request, 'old');
  assert.equal(await cache.get(async () => 'fresh'), 'fresh');
});

test('主动失效清除热快照', async () => {
  const cache = createNavigationCache();
  await cache.get(async () => 'old');
  cache.invalidate();
  assert.equal(await cache.get(async () => 'new'), 'new');
});

for (const oldFails of [false, true]) {
  test(`失效竞态：旧请求${oldFails ? '失败' : '成功'}不会清除新 inflight`, async () => {
    const cache = createNavigationCache();
    const old = deferred();
    const fresh = deferred();
    const previous = cache.get(() => old.promise);
    const settled = Promise.allSettled([previous]);
    cache.invalidate();
    const current = cache.get(() => fresh.promise);
    if (oldFails) old.reject(new Error('old failure')); else old.resolve('old');
    await settled;
    assert.strictEqual(cache.get(async () => 'unexpected'), current);
    fresh.resolve('fresh');
    assert.equal(await current, 'fresh');
    assert.equal(await cache.get(async () => 'unexpected'), 'fresh');
  });
}

test('失效竞态：晚到的旧成功不能覆盖已完成的新快照', async () => {
  const cache = createNavigationCache();
  const old = deferred();
  const previous = cache.get(() => old.promise);
  cache.invalidate();
  assert.equal(await cache.get(async () => 'fresh'), 'fresh');
  old.resolve('old');
  assert.equal(await previous, 'old');
  assert.equal(await cache.get(async () => 'unexpected'), 'fresh');
});

function reviewRepository({ commit, publishFails = false, updateFails = false, replay = false } = {}) {
  const id = '12345678-1234-4234-8234-123456789abc';
  const connection = {
    async query(sql) {
      if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
      if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
      if (sql.startsWith('SELECT')) return [[{
        id, status: replay ? 'approved' : 'pending',
        payload: { reviewReason: '', ...(replay ? { publishedSiteId: 'site-1' } : {}) },
      }]];
      if (sql.startsWith('UPDATE')) {
        if (updateFails) throw new Error('update failed');
        return [{ affectedRows: 1 }];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async beginTransaction() {},
    async commit() { await commit?.(); },
    async rollback() {},
    release() {},
    destroy() {},
  };
  const repository = createMySqlSubmissionRepository({
    getPool: () => ({ getConnection: async () => connection }),
    publisher: async () => { if (publishFails) throw new Error('publish failed'); return 'site-1'; },
  });
  return status => repository.reviewMySqlSubmission(id, status, '', 'admin');
}

test('发布必须等 commit 成功才失效共享缓存', async () => {
  navigationCache.invalidate();
  try {
    await navigationCache.get(async () => 'old');
    const entered = deferred();
    const gate = deferred();
    const review = reviewRepository({ commit: async () => { entered.resolve(); await gate.promise; } });
    const pending = review('approved');
    await entered.promise;
    assert.equal(await navigationCache.get(async () => 'unexpected'), 'old');
    gate.resolve();
    await pending;
    assert.equal(await navigationCache.get(async () => 'fresh'), 'fresh');
  } finally { navigationCache.invalidate(); }
});

for (const scenario of ['commit失败', '发布失败', '更新失败', '拒绝', '幂等重放']) {
  test(`${scenario}不失效导航缓存`, async () => {
    navigationCache.invalidate();
    try {
      await navigationCache.get(async () => 'old');
      const review = reviewRepository({
        commit: scenario === 'commit失败' ? async () => { throw new Error('commit failed'); } : undefined,
        publishFails: scenario === '发布失败', updateFails: scenario === '更新失败', replay: scenario === '幂等重放',
      });
      const request = review(scenario === '拒绝' ? 'rejected' : 'approved');
      if (scenario.endsWith('失败')) await assert.rejects(request, { code: 'SUBMISSIONS_UNAVAILABLE' });
      else await request;
      assert.equal(await navigationCache.get(async () => 'unexpected'), 'old');
    } finally { navigationCache.invalidate(); }
  });
}
