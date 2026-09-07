import test from 'node:test';
import assert from 'node:assert/strict';
import { SITE } from '../src/config/site.ts';
import { validateSettingsCommand, validateSiteSettings, validateHomeSectionPageSize, SITE_FIELD_LIMITS } from '../src/server/settings-validation.ts';
import { createSettingsStore, defaultRuntimeSettings, getRuntimeSettings, settingsRevision } from '../src/server/settings-store.ts';
import { createSettingsHandler, readSettingsRequest } from '../src/server/settings-handler.ts';
import { loginAdmin } from '../src/server/admin-session.ts';

const isError = (status, code) => e => e.status === status && e.code === code;
const defaults = () => defaultRuntimeSettings();
const command = (overrides = {}) => ({ ...defaults(), revision: settingsRevision(defaults()), ...overrides });
/** 事务内存替身：模拟命名锁、提交/回滚、故障，绝不建立真实连接。 */
function database(initial = {}, failure = '') {
  let committed = structuredClone(initial), tail = Promise.resolve();
  const events = [];
  async function select(sql, args, data) {
    assert.match(sql, /WHERE setting_key IN \(\?, \?\)/);
    assert.deepEqual(args, ['site', 'homeSectionPageSize']);
    return [Object.entries(data).filter(([key]) => args.includes(key)).map(([setting_key, payload]) => ({ setting_key, payload }))];
  }
  const pool = {
    async query(sql, args) { events.push('read'); if (failure === 'read') throw Error('secret database'); return select(sql, args, committed); },
    async getConnection() {
      if (failure === 'connect') throw Error('secret database');
      let working, unlock;
      return {
        async query(sql, args) {
          if (sql.includes('GET_LOCK')) {
            events.push('lock'); const previous = tail;
            tail = new Promise(resolve => { unlock = resolve; }); await previous;
            return [[{ acquired: 1 }]];
          }
          if (sql.includes('RELEASE_LOCK')) { events.push('unlock'); unlock(); return [[{ released: 1 }]]; }
          events.push('select'); assert.match(sql, /FOR UPDATE$/); return select(sql, args, working);
        },
        async beginTransaction() { events.push('begin'); working = structuredClone(committed); },
        async execute(sql, [key, value]) {
          assert.match(sql, /INSERT INTO nav_settings.*ON DUPLICATE KEY UPDATE/);
          events.push(`write:${key}`);
          if (failure === key) throw Error('secret database');
          working[key] = JSON.parse(value);
        },
        async commit() { events.push('commit'); if (failure === 'commit') throw Error('secret database'); committed = working; },
        async rollback() { events.push('rollback'); },
        release() { events.push('release'); }, destroy() { events.push('destroy'); },
      };
    },
  };
  return { store: createSettingsStore({ driver: () => 'mysql', getPool: () => pool }), events, data: () => structuredClone(committed) };
}

test('默认值来自最新源码，seed只读，不连接数据库，运行时仅返回两项', async () => {
  const store = createSettingsStore({ driver: () => 'seed', getPool() { assert.fail('禁止连接数据库'); } });
  const snapshot = await store.read();
  assert.deepEqual(snapshot.site, SITE); assert.equal(snapshot.homeSectionPageSize, 18);
  assert.equal(snapshot.writable, false); assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(await getRuntimeSettings(store)), ['site', 'homeSectionPageSize']);
  snapshot.site.name = '污染'; assert.deepEqual((await store.read()).site, SITE);
  await assert.rejects(store.write(command()), isError(503, 'SETTINGS_READ_ONLY'));
});

test('严格七字段、类型、空值、控制字符与所有字段长度边界', () => {
  assert.deepEqual(validateSiteSettings(SITE), SITE);
  for (const value of [null, [], 'x', { ...SITE, lastmod: '2026-01-01' }, { ...SITE, extra: true }])
    assert.throws(() => validateSiteSettings(value), isError(400, 'INVALID_SETTINGS'));
  for (const key of Object.keys(SITE)) {
    const missing = { ...SITE }; delete missing[key];
    assert.throws(() => validateSiteSettings(missing));
    for (const value of ['', ' ', 12, null, 'bad\nvalue', 'x'.repeat(SITE_FIELD_LIMITS[key] + 1)])
      assert.throws(() => validateSiteSettings({ ...SITE, [key]: value }));
    if (key !== 'url') assert.equal(validateSiteSettings({ ...SITE, [key]: '中'.repeat(SITE_FIELD_LIMITS[key]) })[key].length, SITE_FIELD_LIMITS[key]);
  }
});

test('URL仅http(s) origin并规范化，拒绝路径、凭据、危险协议和片段', () => {
  assert.equal(validateSiteSettings({ ...SITE, url: ' HTTPS://Example.COM:443/ ' }).url, 'https://example.com');
  assert.equal(validateSiteSettings({ ...SITE, url: 'http://localhost:4321' }).url, 'http://localhost:4321');
  for (const url of ['javascript:alert(1)', 'ftp://a.test', '//a.test', 'https://a.test/path', 'https://u:p@a.test', 'https://a.test?q=x', 'https://a.test#', 'https://a.test?', 'https:\\a.test', 'bad'])
    assert.throws(() => validateSiteSettings({ ...SITE, url }));
});

test('页大小整数1..48，命令拒绝额外字段、无效revision', () => {
  for (const n of [1, 48]) assert.equal(validateHomeSectionPageSize(n), n);
  for (const n of [0, 49, 1.2, '18', null, NaN, Infinity, true]) assert.throws(() => validateHomeSectionPageSize(n));
  for (const value of [null, [], { ...command(), extra: 1 }, { ...command(), revision: '' }, { ...command(), revision: 1 }])
    assert.throws(() => validateSettingsCommand(value));
});

test('数据库缺键默认；旧site只取七字段；其他历史键不恢复', async () => {
  const { store } = database({ site: { ...SITE, lastmod: 'bad', obsolete: true }, menus: [1], homeTabs: [2] });
  assert.deepEqual(await getRuntimeSettings(store), defaults());
  assert.deepEqual(await getRuntimeSettings(database({ homeSectionPageSize: 32 }).store), { ...defaults(), homeSectionPageSize: 32 });
  assert.deepEqual(await getRuntimeSettings(database({}).store), defaults());
});

test('已存在但损坏的数据库值不降级，数据库异常无敏感信息', async () => {
  for (const data of [{ site: null }, { site: '{' }, { site: {} }, { homeSectionPageSize: 0 }, { homeSectionPageSize: '"18"' }])
    await assert.rejects(database(data).store.read(), isError(503, 'SETTINGS_DATA_INVALID'));
  for (const failure of ['read', 'connect']) {
    const { store } = database({}, failure);
    await assert.rejects(failure === 'read' ? store.read() : store.write(command()), e => e.status === 503 && !e.message.includes('secret'));
  }
});

test('原子写两键、保留历史键、下次读取立即生效、旧revision冲突', async () => {
  const { store, events, data } = database({ oldKey: '保留但不读取' });
  const next = command({ site: { ...SITE, name: '新站点' }, homeSectionPageSize: 24 });
  const saved = await store.write(next);
  assert.equal(saved.writable, true); assert.notEqual(saved.revision, next.revision);
  assert.deepEqual(await getRuntimeSettings(store), { site: next.site, homeSectionPageSize: 24 });
  assert.equal(data().oldKey, '保留但不读取');
  assert.deepEqual(events.slice(0, 8), ['lock', 'begin', 'select', 'write:site', 'write:homeSectionPageSize', 'commit', 'unlock', 'release']);
  await assert.rejects(store.write(next), isError(409, 'SETTINGS_CONFLICT'));
});

test('两键初始缺失时并发同revision只有一个成功', async () => {
  const { store } = database();
  const results = await Promise.allSettled([store.write(command({ homeSectionPageSize: 21 })), store.write(command({ homeSectionPageSize: 22 }))]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.find(x => x.status === 'rejected').reason.code, 'SETTINGS_CONFLICT');
});

test('第二键写入或提交失败必须回滚，不留部分更新', async () => {
  for (const failure of ['homeSectionPageSize', 'commit']) {
    const { store, data, events } = database({}, failure);
    await assert.rejects(store.write(command({ homeSectionPageSize: 30 })), isError(503, 'SETTINGS_UNAVAILABLE'));
    assert.deepEqual(data(), {}); assert.ok(events.includes('rollback')); assert.deepEqual(events.slice(-2), ['unlock', 'release']);
  }
});

const token = 'settings-test-token-'.repeat(4);
function request(method = 'PUT', body = command(), headers = {}) {
  return new Request('https://example.test/api/admin/settings', { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
test('管理接口鉴权、GET/PUT契约、冲突、no-store、方法与请求校验', async () => {
  const original = process.env.ADMIN_TOKEN; process.env.ADMIN_TOKEN = token;
  try {
    const handler = createSettingsHandler(database().store);
    assert.equal((await handler(request('GET', undefined, { authorization: '' }))).status, 401);
    const get = await handler(request('GET')); assert.equal(get.status, 200); assert.equal(get.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys((await get.json()).data), ['site', 'homeSectionPageSize', 'revision', 'writable']);
    const put = await handler(request('PUT', command({ homeSectionPageSize: 31 }))); assert.equal(put.status, 200);
    assert.equal((await put.json()).data.homeSectionPageSize, 31);
    assert.equal((await handler(request())).status, 409);
    for (const headers of [{ origin: 'https://evil.test' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' }])
      assert.equal((await handler(request('PUT', command(), headers))).status, 403);
    assert.equal((await handler(request('PUT', '{'))).status, 400);
    assert.equal((await handler(request('PUT', command(), { 'content-type': 'text/plain' }))).status, 415);
    assert.equal((await handler(request('PUT', { ...command(), site: { ...SITE, lastmod: '2026-01-01' } }))).status, 400);
    assert.equal((await handler(request('POST'))).status, 405);
    assert.equal(await (await handler(request('HEAD'))).text(), '');
    const seed = createSettingsHandler(createSettingsStore({ driver: () => 'seed' }));
    assert.equal((await seed(request())).status, 503);
  } finally { if (original === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = original; }
});

test('JSON流按实际字节限额，不信任Content-Length，释放reader', async () => {
  await assert.rejects(readSettingsRequest(request('PUT', '{}', { 'content-length': '32769' })), isError(413, 'SETTINGS_BODY_TOO_LARGE'));
  const req = request('PUT', JSON.stringify({ text: '中'.repeat(12000) }), { 'content-length': '1' });
  await assert.rejects(readSettingsRequest(req), isError(413, 'SETTINGS_BODY_TOO_LARGE'));
  assert.equal(req.body.locked, false);
  for (const text of ['', '{']) await assert.rejects(readSettingsRequest(request('PUT', text)), isError(400, 'INVALID_JSON'));
});

test('真实管理员Cookie会话：GET允许，PUT必须同源，缺Origin或跨源均拒绝', async () => {
  const previous = { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD };
  process.env.ADMIN_USERNAME = 'settings-test-admin'; process.env.ADMIN_PASSWORD = 'settings-test-password';
  try {
    const session = await loginAdmin(new Request('https://example.test/api/admin/login', {
      method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json' },
      body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }),
    }));
    const headers = { authorization: '', cookie: session.cookie.split(';')[0] };
    const handler = createSettingsHandler(database().store);
    assert.equal((await handler(request('GET', undefined, headers))).status, 200);
    for (const origin of [undefined, 'https://evil.test', 'null']) {
      const response = await handler(request('PUT', command(), { ...headers, ...(origin ? { origin } : {}) }));
      assert.equal(response.status, 403); assert.equal((await response.json()).error.code, 'CROSS_ORIGIN_WRITE');
    }
    assert.equal((await handler(request('PUT', command({ homeSectionPageSize: 20 }), { ...headers, origin: 'https://example.test' }))).status, 200);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
