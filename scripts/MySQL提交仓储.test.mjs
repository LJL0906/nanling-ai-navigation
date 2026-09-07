import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMySqlSubmissionRepository } from '../src/server/mysql-submissions.ts';
import { submissionIdentity } from '../src/server/submission-identity.ts';
import { SUBMISSION_SCHEMA_STATEMENTS } from '../src/server/submission-schema.ts';
import { HttpError } from '../src/server/http.ts';

const owner = randomUUID();
const data = { categoryId: 'ai', customCategory: '', name: '测试', url: 'https://example.test/', iconUrl: '', iconData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII=' };
const errorIs = (status, code) => error => error instanceof HttpError && error.status === status && (!code || error.code === code);
function fakePool(options = {}) {
  const rows = new Map();
  const locks = new Map();
  const events = [];
  let sequence = 0;
  const pool = { async getConnection() {
    if (options.connectFail) throw new Error('mysql://secret');
    const name = ++sequence;
    let undo = new Map();
    const held = new Set();
    const event = (sql, args = []) => events.push({ name, sql, args });
    async function acquire(key) {
      while (locks.has(key)) await locks.get(key).promise;
      let resolve;
      const promise = new Promise(r => { resolve = r; });
      locks.set(key, { promise, resolve });
      held.add(key);
    }
    function release(key) {
      if (!held.delete(key)) return;
      locks.get(key).resolve(); locks.delete(key);
    }
    const connection = {
      async query(sql, args = []) {
        event(sql, args);
        if (options.fail?.(sql)) throw new Error('password=secret SQL internal');
        if (sql.includes('GET_LOCK')) {
          if (options.lockResult !== undefined) return [[{ acquired: options.lockResult }]];
          await acquire(args[0]); return [[{ acquired: 1 }]];
        }
        if (sql.includes('RELEASE_LOCK')) {
          if (options.releaseFail) throw new Error('secret');
          const own = held.has(args[0]); release(args[0]); return [[{ released: own ? 1 : 0 }]];
        }
        if (sql.startsWith('SET TRANSACTION')) return [[]];
        const matches = row => row.status === args[0] && (!sql.includes('LOCATE(')
          || (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload).name.toLowerCase().includes(args[1].toLowerCase()));
        if (sql.startsWith('SELECT COUNT')) return [[{ total: [...rows.values()].filter(matches).length }]];
        if (sql.startsWith('SELECT') && sql.includes('WHERE id')) {
          if (sql.endsWith('FOR UPDATE')) await acquire(`row:${args[0]}`);
          return [[rows.get(args[0])].filter(Boolean).map(r => structuredClone(r))];
        }
        if (sql.startsWith('SELECT') && sql.includes('ORDER BY')) {
          return [[...rows.values()].filter(matches)
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
            .slice(args.at(-1), args.at(-1) + args.at(-2)).map(r => structuredClone(r))];
        }
        if (sql.startsWith('INSERT INTO nav_notifications')) return [{ affectedRows: 1 }];
        if (sql.startsWith('INSERT')) {
          const [id, digest, status, payload, created, user_id] = args;
          if (options.duplicate && !rows.has(id)) rows.set(id, { id, request_digest: digest, status, payload, user_id, created_at: created });
          if (rows.has(id)) throw Object.assign(new Error('duplicate secret'), { code: 'ER_DUP_ENTRY' });
          undo.set(id, undefined);
          rows.set(id, { id, request_digest: digest, status, payload, user_id, created_at: created, published_site_id: null });
          return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE')) {
          const [status, payload, reviewedAt, publishedId, id] = args;
          undo.set(id, structuredClone(rows.get(id)));
          rows.set(id, { ...rows.get(id), status, payload, reviewed_at: reviewedAt, published_site_id: publishedId });
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected SQL ${sql}`);
      },
      async beginTransaction() { event('BEGIN'); if (options.beginFail) throw new Error('secret'); },
      async commit() {
        event('COMMIT'); if (options.commitFail) throw new Error('secret'); undo.clear();
        for (const key of [...held]) if (key.startsWith('row:')) release(key);
      },
      async rollback() {
        event('ROLLBACK');
        for (const [id, old] of undo) { if (old) rows.set(id, old); else rows.delete(id); }
        undo.clear();
        for (const key of [...held]) if (key.startsWith('row:')) release(key);
        if (options.rollbackFail) throw new Error('secret');
      },
      release() { event('RELEASE'); },
      destroy() { event('DESTROY'); for (const key of [...held]) release(key); },
    };
    return connection;
  } };
  return { pool, rows, events, locks };
}
function fixture(options = {}, publisher) {
  const db = fakePool(options);
  const published = [];
  const repo = createMySqlSubmissionRepository({ getPool: () => db.pool,
    uploadQuota: options.uploadQuota ?? (async (_connection, _address, _bytes, upload) => upload()),
    publisher: publisher ?? (async (connection, record) => { published.push({ connection, record }); return 'site-1'; }) });
  let uploads = 0, charges = 0;
  const upload = async () => { uploads++; return { key: 'oss-key', url: 'https://cdn.test/icon' }; };
  const charge = () => { charges++; };
  return { ...db, repo, published, upload, charge, counts: () => ({ uploads, charges }),
    submit: (key = randomUUID(), value = data) => repo.submitToMySql(value, key, upload, charge, '', owner) };
}
test('schema 支持旧摘要NULL、UUID主键、毫秒时间与分页索引', () => {
  const sql = SUBMISSION_SCHEMA_STATEMENTS.join('\n');
  assert.match(sql, /request_digest CHAR\(64\).* NULL/);
  assert.match(sql, /PRIMARY KEY \(id\)/);
  assert.match(sql, /DATETIME\(3\)/);
  assert.match(sql, /published_site_id VARCHAR\(64\).* NULL/);
  assert.match(sql, /status, created_at, id/);
});
test('不同仓储实例共享DB锁，只上传和计费一次；摘要按身份域隔离，payload不留base64', async () => {
  const f = fixture(); const key = randomUUID();
  const second = createMySqlSubmissionRepository({ uploadQuota: async (_connection, _address, _bytes, upload) => upload(), getPool: () => f.pool });
  const results = await Promise.all([f.submit(key), second.submitToMySql(data, key, f.upload, f.charge, '', owner), f.submit(key)]);
  assert.deepEqual(results, Array(3).fill({ id: submissionIdentity(data, key, owner).id, status: 'pending' }));
  assert.deepEqual(f.counts(), { uploads: 1, charges: 1 });
  const row = f.rows.get(results[0].id), payload = JSON.parse(row.payload);
  assert.equal(row.request_digest, submissionIdentity(data, key, owner).digest);
  assert.equal(payload.iconData, ''); assert.equal(payload.iconUrl, 'https://cdn.test/icon');
  assert.deepEqual(payload.iconObject, { provider: 'oss', key: 'oss-key' });
  assert.match(data.iconData, /^data:image\/png;base64,/); assert.equal(f.locks.size, 0);
});
test('相同key异内容409、不扣费；属性顺序不同仍可重放；无key随机UUID', async () => {
  const f = fixture(); const key = randomUUID(); await f.submit(key);
  await assert.rejects(f.submit(key, { ...data, name: '不同' }), errorIs(409));
  await f.submit(key, Object.fromEntries(Object.entries(data).reverse()));
  assert.deepEqual(f.counts(), { uploads: 1, charges: 1 });
  const a = await f.repo.submitToMySql(data, undefined, f.upload, f.charge, '', owner);
  const b = await f.repo.submitToMySql(data, undefined, f.upload, f.charge, '', owner);
  assert.notEqual(a.id, b.id);
});
test('旧记录NULL摘要拒绝重放且不上传', async () => {
  const f = fixture(); const key = randomUUID(); const { id } = await f.submit(key); f.rows.get(id).request_digest = null;
  await assert.rejects(f.submit(key), errorIs(409, 'IDEMPOTENCY_CONFLICT')); assert.deepEqual(f.counts(), { uploads: 1, charges: 1 });
});
test('审核通过先命名锁再事务及行锁，发布与状态同事务；相同决策重放不重复发布', async () => {
  const f = fixture(); const key = randomUUID(); const { id } = await f.submit(key); f.events.length = 0;
  const approved = await f.repo.reviewMySqlSubmission(id, 'approved', '', 'admin');
  assert.equal(approved.publishedSiteId, 'site-1'); assert.equal(f.rows.get(id).published_site_id, 'site-1');
  const sql = f.events.map(e => e.sql);
  assert.match(sql[0], /GET_LOCK/); assert.equal(f.events[0].args[0], 'nav-submissions:publish');
  assert.equal(sql[1], 'BEGIN'); assert.match(sql[2], /FOR UPDATE/);
  assert.ok(sql.indexOf('COMMIT') > sql.findIndex(s => s.startsWith('UPDATE')));
  assert.deepEqual(await f.repo.reviewMySqlSubmission(id, 'approved', '', 'other-admin'), approved);
  assert.equal(f.published.length, 1);
  assert.deepEqual(await f.submit(key), { id, status: 'pending' });
  await assert.rejects(f.repo.reviewMySqlSubmission(id, 'rejected', '理由', 'admin'), errorIs(409));
  assert.equal(f.locks.size, 0);
});
test('拒绝不发布，不获取发布锁；不同理由409；不存在404', async () => {
  const f = fixture(); const { id } = await f.submit(); f.events.length = 0;
  const result = await f.repo.reviewMySqlSubmission(id, 'rejected', '不合适', 'admin');
  assert.deepEqual(await f.repo.reviewMySqlSubmission(id, 'rejected', '不合适', 'admin'), result);
  await assert.rejects(f.repo.reviewMySqlSubmission(id, 'rejected', '变化', 'admin'), errorIs(409));
  await assert.rejects(f.repo.reviewMySqlSubmission(randomUUID(), 'approved', '', 'admin'), errorIs(404));
  assert.equal(f.published.length, 0); assert.equal(f.rows.get(id).published_site_id, null);
});
test('历史approved重放不补发正式站点', async () => {
  const f = fixture(); const { id } = await f.submit(); const row = f.rows.get(id);
  row.status = 'approved'; row.payload = JSON.stringify({ ...JSON.parse(row.payload), reviewReason: '旧理由' });
  await f.repo.reviewMySqlSubmission(id, 'approved', '旧理由', 'admin');
  assert.equal(f.published.length, 0); assert.equal(row.published_site_id, null);
});
test('不同提交approved全局串行publisher，同提交并发重放仅发布一次', async () => {
  let active = 0, max = 0, calls = 0;
  const f = fixture({}, async () => {
    active++; max = Math.max(max, active); calls++;
    await new Promise(resolve => setTimeout(resolve, 5)); active--; return 'site-1';
  });
  const a = await f.submit(), b = await f.submit();
  await Promise.all([a.id, b.id, a.id].map(id => f.repo.reviewMySqlSubmission(id, 'approved', '', 'admin')));
  assert.equal(max, 1); assert.equal(calls, 2); assert.equal(f.locks.size, 0);
});
test('publisher失败回滚并释放全局锁，不改变pending', async () => {
  const f = fixture({}, async () => { throw new Error('secret'); }); const { id } = await f.submit();
  await assert.rejects(f.repo.reviewMySqlSubmission(id, 'approved', '', 'admin'), errorIs(503));
  assert.equal(f.rows.get(id).status, 'pending'); assert.equal(f.locks.size, 0);
  assert.ok(f.events.some(e => e.sql === 'ROLLBACK'));
});
for (const options of [{ fail: s => s.startsWith('INSERT') }, { beginFail: true }, { commitFail: true },
  { commitFail: true, rollbackFail: true }, { lockResult: 0 }, { lockResult: null }, { connectFail: true }]) {
  test(`提交错误脱敏及资源清理 ${JSON.stringify(options)}`, async () => {
    const f = fixture(options);
    await assert.rejects(f.submit(), error => errorIs(503)(error) && !error.message.includes('secret'));
    assert.equal(f.rows.size, 0); assert.equal(f.locks.size, 0);
  });
}
test('释放锁失败销毁连接，已提交结果保持成功', async () => {
  const f = fixture({ releaseFail: true }); await f.submit();
  assert.ok(f.events.some(e => e.sql === 'DESTROY')); assert.equal(f.locks.size, 0);
});
test('唯一键兜底回滚后按原摘要重放', async () => {
  const f = fixture({ duplicate: true }); const result = await f.submit();
  assert.equal(result.status, 'pending'); assert.equal(f.rows.size, 1);
  assert.ok(f.events.some(e => e.sql === 'ROLLBACK'));
});
test('上传和限流失败不写记录且释放锁', async () => {
  const f = fixture();
  await assert.rejects(f.repo.submitToMySql(data, randomUUID(), async () => { throw new Error('secret'); }, f.charge, '', owner), errorIs(503));
  await assert.rejects(f.repo.submitToMySql(data, randomUUID(), f.upload, () => { throw new HttpError(429, 'RATE_LIMITED', '限流'); }, '', owner), errorIs(429));
  assert.equal(f.rows.size, 0); assert.equal(f.locks.size, 0); assert.equal(f.counts().uploads, 0);
});
test('SQL过滤稳定排序分页，返回完整payload且同步状态', async () => {
  const f = fixture(); const ids = [(await f.submit()).id, (await f.submit()).id].sort();
  for (const row of f.rows.values()) { row.created_at = '2026-09-07 00:00:00.000'; row.payload = JSON.parse(row.payload); row.payload.extra = '保留'; row.payload.status = '过期'; }
  const result = await f.repo.listMySqlSubmissions({ status: 'pending', page: 2, pageSize: 1 });
  assert.equal(result.total, 2); assert.equal(result.items.length, 1); assert.equal(result.items[0].id, ids[1]);
  assert.equal(result.items[0].status, 'pending'); assert.equal(result.items[0].extra, '保留');
  const query = f.events.find(e => e.sql.includes('ORDER BY')); assert.deepEqual(query.args, ['pending', 1, 1]);
  await assert.rejects(f.repo.listMySqlSubmissions({ status: 'bad', page: 1, pageSize: 1 }), errorIs(400));
  await assert.rejects(f.repo.listMySqlSubmissions({ status: 'pending', page: 0, pageSize: 1 }), errorIs(400));
  f.rows.get(ids[0]).payload = '{invalid';
  await assert.rejects(f.repo.listMySqlSubmissions({ status: 'pending', page: 1, pageSize: 20 }), errorIs(503));
});

for (const stage of ['UPDATE', 'COMMIT']) test(`发布后的${stage}失败回滚审核并释放发布锁`, async () => {
  const options = {};
  const f = fixture(options); const { id } = await f.submit();
  if (stage === 'UPDATE') options.fail = sql => sql.startsWith('UPDATE');
  else options.commitFail = true;
  f.events.length = 0;
  await assert.rejects(f.repo.reviewMySqlSubmission(id, 'approved', '', 'admin'), errorIs(503));
  assert.equal(f.published.length, 1); assert.equal(f.rows.get(id).status, 'pending');
  assert.equal(f.rows.get(id).published_site_id, null); assert.equal(f.locks.size, 0);
  const sql = f.events.map(e => e.sql);
  assert.ok(sql.indexOf('ROLLBACK') < sql.findIndex(s => s.includes('RELEASE_LOCK')));
});
test('无图片不调用OSS；成功审核commit之后才释放发布锁', async () => {
  const f = fixture(); const { id } = await f.submit(randomUUID(), { ...data, iconData: '' });
  assert.deepEqual(f.counts(), { uploads: 0, charges: 1 }); f.events.length = 0;
  await f.repo.reviewMySqlSubmission(id, 'approved', '', 'admin');
  const sql = f.events.map(e => e.sql);
  assert.ok(sql.indexOf('COMMIT') < sql.findIndex(s => s.includes('RELEASE_LOCK')));
});


test('实际上传前必须经过配额，按解码字节与服务端地址计量；重放不重复扣额', async () => {
  const calls = [];
  const f = fixture({uploadQuota: async (connection, address, bytes, upload) => {
    calls.push({connection, address, bytes}); return upload();
  }});
  const key = randomUUID();
  const first = await f.repo.submitToMySql(data, key, f.upload, f.charge, '203.0.113.23', owner);
  const second = await f.repo.submitToMySql(data, key, f.upload, f.charge, '203.0.113.23', owner);
  assert.deepEqual(first,second);
  assert.equal(calls.length,1);
  assert.equal(calls[0].address,'203.0.113.23');
  assert.equal(calls[0].bytes,Buffer.from(data.iconData.split(',')[1],'base64').length);
  assert.ok(calls[0].connection);
  assert.equal(f.counts().uploads,1);
});

test('配额超限、关闭或数据库不可用不上传、不保存；在线地址与无图标不消耗配额', async () => {
  for (const [status,code] of [[429,'UPLOAD_LIMIT_REACHED'],[503,'UPLOAD_DISABLED'],[503,'UPLOAD_QUOTA_UNAVAILABLE']]) {
    let quotas = 0;
    const f = fixture({uploadQuota: async () => {quotas++; throw new HttpError(status,code,'上传受限');}});
    await assert.rejects(f.repo.submitToMySql(data,randomUUID(),f.upload,f.charge,'203.0.113.2',owner),errorIs(status,code));
    assert.equal(quotas,1); assert.equal(f.counts().uploads,0); assert.equal(f.rows.size,0); assert.equal(f.locks.size,0);
    for (const iconUrl of ['', 'https://example.test/icon.png']) {
      await f.repo.submitToMySql({...data,iconData:'',iconUrl},randomUUID(),f.upload,f.charge,'203.0.113.2',owner);
    }
    assert.equal(quotas,1); assert.equal(f.rows.size,2);
  }
});



test('MySQL名称搜索参数化、字面量包含匹配，计数与分页共用筛选', async () => {
  const f = fixture();
  for (const name of ['Alpha one', '无关', 'two ALPHA', '100%工具', 'my_tool', 'myXtool', "quote' OR 1=1 --", '中文导航']) {
    await f.submit(randomUUID(), { ...data, name });
  }
  const approved = await f.submit(randomUUID(), { ...data, name: 'Alpha 已通过' });
  f.rows.get(approved.id).status = 'approved';
  for (const [q, total] of [['  aLpHa  ', 2], ['%', 1], ['_', 1], ["' OR 1=1 --", 1], ['中文', 1], ['不存在', 0], ['x'.repeat(100), 0]]) {
    f.events.length = 0;
    const result = await f.repo.listMySqlSubmissions({ status: 'pending', page: 1, pageSize: 1, q });
    assert.equal(result.total, total); assert.equal(result.items.length, Math.min(total, 1));
    for (const item of result.items) assert.ok(item.name.toLowerCase().includes(q.trim().toLowerCase()));
    const count = f.events.find(e => e.sql.startsWith('SELECT COUNT'));
    const list = f.events.find(e => e.sql.includes('ORDER BY'));
    assert.deepEqual(count.args, ['pending', q.trim()]);
    assert.deepEqual(list.args, [...count.args, 1, 0]);
    assert.equal(count.sql.split(' WHERE ')[1], list.sql.split(' WHERE ')[1].split(' ORDER BY ')[0]);
    assert.ok(count.sql.includes("LOCATE(LOWER(?), LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')))) > 0"));
    assert.equal((list.sql.match(/\?/g) ?? []).length, 4);
    assert.doesNotMatch(list.sql, /LIKE/);
  }
  const all = await f.repo.listMySqlSubmissions({ status: 'pending', page: 1, pageSize: 100, q: 'alpha' });
  const second = await f.repo.listMySqlSubmissions({ status: 'pending', page: 2, pageSize: 1, q: 'alpha' });
  assert.equal(second.total, 2); assert.deepEqual(second.items, [all.items[1]]);
  const beyond = await f.repo.listMySqlSubmissions({ status: 'pending', page: 3, pageSize: 1, q: 'alpha' });
  assert.equal(beyond.total, 2); assert.deepEqual(beyond.items, []);
  const original = await f.repo.listMySqlSubmissions({ status: 'pending', page: 1, pageSize: 100 });
  for (const q of ['', '   ']) assert.deepEqual(await f.repo.listMySqlSubmissions({ status: 'pending', page: 1, pageSize: 100, q }), original);
});

test('MySQL搜索拒绝非法类型和超长参数且不连接数据库', async () => {
  const f = fixture();
  for (const q of [null, 1, {}, [], 'x'.repeat(101)]) {
    await assert.rejects(f.repo.listMySqlSubmissions({ status: 'pending', page: 1, pageSize: 20, q }), errorIs(400, 'INVALID_QUERY'));
  }
  assert.deepEqual(f.events, []);
});
