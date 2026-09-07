import test from 'node:test';
import assert from 'node:assert/strict';
import { getAdminSession, loginAdmin, SESSION_TTL_MS, safeAdminNext } from '../src/server/admin-session.ts';
import { requireAdmin } from '../src/server/auth.ts';
import { GET, POST, DELETE, ALL } from '../src/pages/api/admin/session.ts';
import { onRequest } from '../src/middleware.ts';

const origin = 'https://example.test';
const request = (method = 'GET', cookie = '', body, headers = {}) => new Request(`${origin}/api/admin/session`, {
  method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), Cookie: cookie,
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});
const account = { username: 'test-admin', password: 'test-only-long-secret' };
const errorStatus = status => error => error.status === status;
const call = (handler, req) => handler({ request: req });

// 只修改测试进程环境，不加载或读取真实 .env。
test('管理员会话完整安全回归', async t => {
  const old = { username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD, token: process.env.ADMIN_TOKEN };
  delete process.env.ADMIN_TOKEN;
  process.env.ADMIN_USERNAME = account.username;
  process.env.ADMIN_PASSWORD = account.password;
  t.after(() => {
    for (const [key, value] of Object.entries({ ADMIN_USERNAME: old.username, ADMIN_PASSWORD: old.password, ADMIN_TOKEN: old.token })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let cookie;
  await t.test('登录、查询与无token账户认证', async () => {
    assert.equal((await call(GET, request())).status, 401);
    const response = await call(POST, request('POST', '', account));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { username: account.username } });
    const header = response.headers.get('set-cookie');
    for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=28800']) assert.ok(header.includes(attribute));
    cookie = header.split(';')[0];
    assert.ok(!cookie.includes(account.password));
    assert.deepEqual(await (await call(GET, request('GET', cookie))).json(), { data: { username: account.username } });
    assert.doesNotThrow(() => requireAdmin(request('GET', cookie)));
    assert.doesNotThrow(() => requireAdmin(request('PUT', cookie)));
  });
  await t.test('Cookie写操作、登录和退出拒绝跨站及缺失Origin', async () => {
    for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
      assert.throws(() => requireAdmin(request('PUT', cookie, undefined, headers)), errorStatus(403));
      assert.equal((await call(POST, request('POST', '', account, headers))).status, 403);
      assert.equal((await call(DELETE, request('DELETE', cookie, undefined, headers))).status, 403);
    }
    assert.ok(getAdminSession(request('GET', cookie)));
  });
  await t.test('兼容Bearer CLI且不接受URL令牌', () => {
    const token = 't'.repeat(64);
    assert.doesNotThrow(() => requireAdmin(request('PUT', '', undefined, { Authorization: `Bearer ${token}`, Origin: '' }), token));
    assert.throws(() => requireAdmin(request('GET', '', undefined, { Authorization: 'Bearer wrong' }), token), errorStatus(401));
    assert.throws(() => requireAdmin(new Request(`${origin}/?token=${token}`), token), errorStatus(401));
  });
  await t.test('伪造与重复cookie不能认证', () => {
    assert.equal(getAdminSession(request('GET', 'admin_session=' + 'a'.repeat(64))), null);
    assert.equal(getAdminSession(request('GET', `${cookie}; ${cookie}`)), null);
  });
  await t.test('管理页跳转、登录豁免及响应安全头', async () => {
    const run = (path, value = '') => {
      const req = new Request(origin + path, { headers: { Cookie: value } });
      return onRequest({ locals: {}, request: req, url: new URL(req.url), redirect: (url, status) => new Response(null, { status, headers: { Location: url } }) }, () => new Response('page'));
    };
    const response = await run('/admin/menus/?tab=a');
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/admin/login/?next=%2Fadmin%2Fmenus%2F%3Ftab%3Da');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    for (const path of ['/admin/login/', '/admin/login', '/', '/api/admin/session']) assert.equal((await run(path)).status, 200);
    assert.equal((await run('/admin/', cookie)).status, 200);
    for (const path of ['//evil.test', '/admin/../evil', '/admin/%2e%2e/evil', '/admin/\\evil', '/admin//evil', '/admin/login/?next=/admin/', 'https://evil.test', '/admin/\n']) assert.equal(safeAdminNext(path), '/admin/');
    assert.equal(safeAdminNext('/admin/menus/?tab=a'), '/admin/menus/?tab=a');
  });
  await t.test('退出清cookie且服务器立即撤销', async () => {
    const response = await call(DELETE, request('DELETE', cookie));
    assert.deepEqual(await response.json(), { data: { username: null } });
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await call(GET, request('GET', cookie))).status, 401);
  });
  await t.test('过期、密码更换及会话轮换撤销旧凭据', async () => {
    const start = Date.now();
    const first = await loginAdmin(request('POST', '', account), start);
    const firstCookie = first.cookie.split(';')[0];
    assert.equal(getAdminSession(request('GET', firstCookie), start + SESSION_TTL_MS), null);
    const second = await loginAdmin(request('POST', '', account));
    const secondCookie = second.cookie.split(';')[0];
    const third = await loginAdmin(request('POST', secondCookie, account));
    assert.equal(getAdminSession(request('GET', secondCookie)), null);
    process.env.ADMIN_PASSWORD = 'changed-password';
    assert.equal(getAdminSession(request('GET', third.cookie.split(';')[0])), null);
    process.env.ADMIN_PASSWORD = account.password;
  });
  await t.test('无默认密码、未配账户拒绝登录，原Bearer未配503保留', async () => {
    delete process.env.ADMIN_PASSWORD;
    assert.equal((await call(POST, request('POST', '', account))).status, 503);
    assert.throws(() => requireAdmin(request(), ''), errorStatus(503));
    process.env.ADMIN_PASSWORD = account.password;
  });
  await t.test('JSON错误、体积上限、方法错误遵守helper', async () => {
    const bad = await call(POST, request('POST', '', { username: [] }));
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_JSON');
    assert.equal(bad.headers.get('cache-control'), 'no-store');
    assert.equal((await call(POST, request('POST', '', account, { 'Content-Type': 'text/plain' }))).status, 415);
    assert.equal((await call(POST, request('POST', '', { ...account, password: 'x'.repeat(9000) }))).status, 413);
    assert.equal((await call(ALL, request())).status, 405);
  });
  await t.test('并发登录失败限流，窗口到期恢复', async () => {
    const future = Date.now() + 16 * 60 * 1000;
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => loginAdmin(request('POST', '', { ...account, password: 'wrong' }), future)));
    assert.equal(results.filter(result => result.reason?.status === 401).length, 10);
    assert.equal(results.filter(result => result.reason?.status === 429).length, 5);
    await assert.rejects(loginAdmin(request('POST', '', account), future), errorStatus(429));
    const restored = await loginAdmin(request('POST', '', account), future + 15 * 60 * 1000);
    assert.equal(restored.username, account.username);
  });
});
