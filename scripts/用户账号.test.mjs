import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getAdminSession, loginAdmin, logoutAdmin } from '../src/server/admin-session.ts';
import { requireAdmin } from '../src/server/auth.ts';
import { createAccountService } from '../src/server/account.ts';
import { assertAccountStorage, withAccountConnection } from '../src/server/account-db.ts';
import { ACCOUNT_SCHEMA_STATEMENTS } from '../src/server/account-schema.ts';
import {
  ACCOUNT_COOKIE, ACCOUNT_TTL_MS, accountCookie, accountToken, accountTokenHash,
  hashAccountPassword, verifyAccountPassword, validateAccountCredentials,
  readAccountCredentials, requireAccountOrigin, createAccountLimiter, getAccountSource,
} from '../src/server/account-security.ts';
import { safeAccountNext } from '../src/scripts/account-next.ts';
import { api, HttpError } from '../src/server/http.ts';
import { GET, ALL } from '../src/pages/api/account/session.ts';
import { ALL as registerAll } from '../src/pages/api/account/register.ts';

const origin = 'https://account.test';
const credentials = { username: 'Alice_123', password: 'correct-password-123' };
const status = code => error => error.status === code;
function request(method = 'GET', body, cookie = '', extra = {}) {
  return new Request(`${origin}/api/account/session`, {
    method, headers: { Origin: origin, Cookie: cookie, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
function fixture() {
  let time = Date.UTC(2026, 8, 7);
  let users = new Map();
  let sessions = new Map();
  let snapshot;
  let failSession = false;
  const calls = [];
  const connection = {
    async beginTransaction() { snapshot = { users: new Map(users), sessions: new Map(sessions) }; calls.push(['begin']); },
    async commit() { snapshot = undefined; calls.push(['commit']); },
    async rollback() { users = snapshot.users; sessions = snapshot.sessions; calls.push(['rollback']); },
    async execute(sql, values) {
      calls.push([sql, values]);
      assert.ok(Array.isArray(values), '动态 SQL 必须使用占位符及参数数组');
      assert.equal((sql.match(/\?/g) ?? []).length, values.length);
      if (sql.startsWith('INSERT INTO nav_users')) {
        if (users.has(values[1])) throw Object.assign(new Error('sensitive SQL'), { code: 'ER_DUP_ENTRY' });
        users.set(values[1], { id: values[0], username: values[1], password_hash: values[2] });
      } else if (sql.startsWith('INSERT INTO nav_user_sessions')) {
        if (failSession) throw new Error('sensitive SQL password=secret');
        sessions.set(values[0], { user_id: values[1], expires: values[2].getTime() });
      } else if (sql.startsWith('DELETE FROM nav_user_sessions')) {
        sessions.delete(values[0]);
      } else if (sql.startsWith('SELECT id, username')) {
        return [[users.get(values[0])].filter(Boolean), []];
      } else if (sql.startsWith('SELECT u.id')) {
        assert.match(sql, /s.expires_at > UTC_TIMESTAMP\(3\)/);
        const session = sessions.get(values[0]);
        const user = session?.expires > time ? [...users.values()].find(user => user.id === session.user_id) : undefined;
        return [user ? [{ id: user.id, username: user.username }] : [], []];
      } else { throw new Error(`Unexpected SQL: ${sql}`); }
      return [{ affectedRows: 1 }, []];
    },
  };
  const service = createAccountService({
    assertStorage() {}, now: () => time, limit: createAccountLimiter(() => time),
    hash: async password => `test-hash:${password}`,
    verify: async (password, hash) => hash === `test-hash:${password}`,
    connection: async callback => {
      try { return await callback(connection); }
      catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, 'ACCOUNT_DATABASE_UNAVAILABLE', '用户服务暂时不可用，请稍后重试。'); }
    },
  });
  return { service, calls, users: () => users, sessions: () => sessions,
    advance: amount => { time += amount; }, failSession: () => { failSession = true; } };
}

test('真实异步 scrypt：随机盐、正确密码、错误密码、损坏摘要与未知账号', async () => {
  const first = await hashAccountPassword(credentials.password);
  const second = await hashAccountPassword(credentials.password);
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.ok(!first.includes(credentials.password));
  assert.equal(await verifyAccountPassword(credentials.password, first), true);
  assert.equal(await verifyAccountPassword('wrong-password', first), false);
  assert.equal(await verifyAccountPassword(credentials.password, null), false);
  assert.equal(await verifyAccountPassword(credentials.password, 'scrypt$999999999$1$1$aa$bb'), false);
});

test('用户名规范化、边界、密码保留空格且不接受非字符串', () => {
  assert.equal(validateAccountCredentials(credentials).username, 'alice_123');
  for (const username of ['ab', 'a'.repeat(33), ' 张三 ', ' alice', 'alice-', '中文名', "a' OR 1=1"]) {
    assert.throws(() => validateAccountCredentials({ ...credentials, username }), status(400));
  }
  for (const password of ['x'.repeat(9), 'x'.repeat(129), 123456789012, null]) {
    assert.throws(() => validateAccountCredentials({ ...credentials, password }), status(400));
  }
  assert.equal(validateAccountCredentials({ username: 'A'.repeat(32), password: 'x'.repeat(128) }).password.length, 128);
  assert.equal(validateAccountCredentials({ username: 'abc', password: ' abcdefghi ' }).password, ' abcdefghi ');
  assert.throws(() => validateAccountCredentials([]), status(400));
});

test('流式正文大小限制不信任 content-length；JSON/UTF-8 校验', async () => {
  assert.equal((await readAccountCredentials(request('POST', credentials))).username, 'alice_123');
  const encoder = new TextEncoder();
  let cancelled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode('x'.repeat(3000)));
    controller.enqueue(encoder.encode('y'.repeat(3000)));
  }, cancel() { cancelled = true; } });
  await assert.rejects(readAccountCredentials(new Request(`${origin}/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '1' }, body, duplex: 'half',
  })), status(413));
  assert.equal(cancelled, true);
  await assert.rejects(readAccountCredentials(request('POST', credentials, '', { 'Content-Length': '99999' })), status(413));
  await assert.rejects(readAccountCredentials(request('POST', credentials, '', { 'Content-Type': 'text/plain' })), status(415));
  await assert.rejects(readAccountCredentials(new Request(`${origin}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })), status(400));
  await assert.rejects(readAccountCredentials(new Request(`${origin}/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: new Uint8Array([0xff]) })), status(400));
});

test('同源写校验、管理员 cookie 无效、重复 cookie 无效、Secure 按请求 HTTPS', () => {
  requireAccountOrigin(request('DELETE'));
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: '' }]) {
    assert.throws(() => requireAccountOrigin(request('DELETE', undefined, '', headers)), status(403));
  }
  const token = 'a'.repeat(64);
  assert.equal(accountToken(request('GET', undefined, `admin_session=${token}`)), null);
  assert.equal(accountToken(request('GET', undefined, `${ACCOUNT_COOKIE}=${token}; ${ACCOUNT_COOKIE}=${token}`)), null);
  assert.equal(accountToken(request('GET', undefined, `${ACCOUNT_COOKIE}=invalid`)), null);
  assert.match(accountCookie(request(), token), /HttpOnly; SameSite=Lax; Max-Age=604800; Secure$/);
  assert.doesNotMatch(accountCookie(new Request('http://localhost/'), token), /Secure/);
});

test('注册自动登录→会话查询→固定七天到期→登录轮换→退出删除数据库摘要', async () => {
  const f = fixture();
  const registered = await f.service.register(request('POST', credentials));
  assert.deepEqual(Object.keys(registered.user).sort(), ['id', 'username']);
  assert.match(registered.user.id, /^[a-f0-9-]{36}$/);
  assert.equal(registered.user.username, 'alice_123');
  const cookie = registered.cookie.split(';')[0];
  const token = cookie.split('=')[1];
  assert.ok(f.sessions().has(accountTokenHash(token)));
  assert.ok(!f.sessions().has(token));
  assert.equal(f.sessions().get(accountTokenHash(token)).expires, Date.UTC(2026, 8, 14));
  assert.deepEqual(await f.service.requireUser(request('GET', undefined, cookie)), registered.user);
  f.advance(ACCOUNT_TTL_MS - 1);
  assert.ok(await f.service.getUser(request('GET', undefined, cookie)));
  f.advance(1);
  assert.equal(await f.service.getUser(request('GET', undefined, cookie)), null);
  await assert.rejects(f.service.requireUser(request('GET', undefined, cookie)), status(401));
  const login = await f.service.login(request('POST', credentials, cookie));
  assert.notEqual(login.cookie, registered.cookie);
  assert.equal(f.sessions().size, 1);
  assert.ok(!f.sessions().has(accountTokenHash(token)));
  const newCookie = login.cookie.split(';')[0];
  assert.match(await f.service.logout(request('DELETE', undefined, newCookie)), /Max-Age=0; Secure$/);
  assert.equal(f.sessions().size, 0);
  assert.equal(await f.service.getUser(request('GET', undefined, newCookie)), null);
  assert.match(await f.service.logout(request('DELETE')), /Max-Age=0/);
});

test('重复注册、错误凭证不泄露 SQL 或密码，写入会话失败回滚新用户', async () => {
  const f = fixture();
  await f.service.register(request('POST', credentials));
  await assert.rejects(f.service.register(request('POST', { ...credentials, username: 'ALICE_123' })), status(409));
  const wrong = await api(() => f.service.login(request('POST', { ...credentials, password: 'wrong-password' })));
  const unknown = await api(() => f.service.login(request('POST', { ...credentials, username: 'nobody' })));
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), await unknown.json());
  assert.equal(f.users().size, 1);
  const broken = fixture();
  broken.failSession();
  const response = await api(() => broken.service.register(request('POST', credentials)));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /sensitive|SQL|secret|correct-password/);
  assert.equal(broken.users().size, 0);
  assert.equal(broken.sessions().size, 0);
  assert.ok(broken.calls.some(([call]) => call === 'rollback'));
});

test('跨站登录、注册、退出均在访问数据库/哈希前拒绝', async () => {
  const f = fixture();
  for (const method of ['login', 'register', 'logout']) {
    await assert.rejects(f.service[method](request('POST', credentials, '', { Origin: 'https://evil.test' })), status(403));
  }
  assert.equal(f.calls.length, 0);
});

test('限流：未知来源共享预算、用户名预算、窗口过期重置', () => {
  let time = 0;
  const limit = createAccountLimiter(() => time);
  for (let i = 0; i < 30; i++) limit('register');
  assert.throws(() => limit('register'), status(429));
  for (let i = 0; i < 10; i++) limit('login', 'alice');
  assert.throws(() => limit('login', 'alice'), status(429));
  limit('login', 'bob');
  time = 15 * 60 * 1000;
  limit('register');
  limit('login', 'alice');
});

test('NAV_STORAGE 非 mysql 所有账号操作返回503，不连接数据库；HTTP错误与允许方法', async t => {
  const previous = process.env.NAV_STORAGE;
  process.env.NAV_STORAGE = 'seed';
  t.after(() => { if (previous === undefined) delete process.env.NAV_STORAGE; else process.env.NAV_STORAGE = previous; });
  assert.throws(assertAccountStorage, status(503));
  await assert.rejects(withAccountConnection(async () => assert.fail('不应创建连接')), status(503));
  const service = createAccountService();
  for (const method of ['getUser', 'requireUser', 'login', 'register', 'logout']) {
    await assert.rejects(service[method](request()), status(503));
  }
  const response = await GET({ request: request() });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await ALL({})).status, 405);
  assert.equal((await registerAll({})).headers.get('Allow'), 'POST');
});

test('next拒绝外链、双斜杠、反斜杠、编码绕过、路径归一化绕过；正常本站路径保留', () => {
  for (const value of ['https://evil.test', '//evil.test', '/\\evil.test', '/%5cevil.test', '/%2fevil.test',
    '/%252fevil.test', '/%00evil', '/\tevil', '/a/..//evil.test', '/a/%2e%2e//evil.test', '/login/', '/register/?next=/', '/%zz']) {
    assert.equal(safeAccountNext(value), '/', value);
  }
  assert.equal(safeAccountNext('/favorites/?page=2#saved'), '/favorites/?page=2#saved');
  assert.equal(safeAccountNext('/history/'), '/history/');
});

test('迁移提供 ascii_bin 主键、用户名唯一、摘要会话、外键及过期索引', () => {
  assert.equal(ACCOUNT_SCHEMA_STATEMENTS.length, 2);
  assert.match(ACCOUNT_SCHEMA_STATEMENTS[0], /CHAR\(36\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY/);
  assert.match(ACCOUNT_SCHEMA_STATEMENTS[0], /UNIQUE KEY nav_users_username_unique/);
  assert.match(ACCOUNT_SCHEMA_STATEMENTS[1], /token_hash CHAR\(64\)/);
  assert.match(ACCOUNT_SCHEMA_STATEMENTS[1], /ON DELETE CASCADE/);
  assert.match(ACCOUNT_SCHEMA_STATEMENTS[1], /nav_user_sessions_expiry/);
});

test('登录注册弹窗不重定向、原生showModal/ESC、顶部按钮入口及统一事件契约', async () => {
  const read = path => readFile(new URL(path, import.meta.url), 'utf8');
  const [dialog, script, forms, component, account] = await Promise.all([
    read('../src/components/layout/AccountDialog.astro'), read('../src/scripts/account-dialog.ts'),
    read('../src/scripts/account-form.ts'), read('../src/components/layout/AccountStatus.astro'),
    read('../src/scripts/account-status.ts'),
  ]);
  assert.match(dialog, /<dialog.*aria-labelledby/);
  assert.match(dialog, /::backdrop/);
  assert.match(dialog, /data-account-mode="register"/);
  assert.match(script, /dialog.showModal\(\)/);
  assert.match(script, /document.addEventListener\('nav:auth-required'/);
  assert.match(component, /data-account-open="login"/);
  assert.match(component, /data-account-open="register"/);
  assert.doesNotMatch(component, /server\/account|href="\/login/);
  assert.match(forms, /if \(!form.hasAttribute\('data-account-modal'\)\) location.assign/);
  assert.match(forms, /notifyAccountChanged\(mode\)/);
  assert.match(account, /notifyAccountChanged\('logout'\)/);
  assert.match(account, /document.addEventListener\('nav:account-changed'/);
});

test('账号状态广播只发送reason，跨tab只派发本地事件不循环广播', async t => {
  const old = Object.fromEntries(['document', 'window', 'BroadcastChannel'].map(key => [key, globalThis[key]]));
  const sent = [];
  let channel;
  globalThis.document = new EventTarget();
  globalThis.window = new EventTarget();
  globalThis.BroadcastChannel = class extends EventTarget {
    constructor(name) { super(); assert.equal(name, 'nav:account-changed'); channel = this; }
    postMessage(value) { sent.push(value); }
  };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const events = [];
  document.addEventListener('nav:account-changed', event => events.push(event.detail));
  const { notifyAccountChanged } = await import('../src/scripts/account-events.ts');
  notifyAccountChanged('login');
  assert.deepEqual(sent, [{ reason: 'login' }]);
  assert.deepEqual(events, [{ reason: 'login' }]);
  channel.dispatchEvent(new MessageEvent('message', { data: { reason: 'logout', username: 'do-not-forward' } }));
  assert.deepEqual(events[1], { reason: 'logout' });
  assert.equal(sent.length, 1);
  channel.dispatchEvent(new MessageEvent('message', { data: { reason: 'invalid' } }));
  assert.equal(events.length, 2);
});


test('可信source仅由context.clientAddress读取，抛错/缺失保守回退，不采用XFF', () => {
  assert.equal(getAccountSource({ clientAddress: '192.0.2.1', request: request('POST', {}, '', { 'X-Forwarded-For': '198.51.100.1' }) }), '192.0.2.1');
  assert.equal(getAccountSource({ get clientAddress() { throw new Error('adapter unavailable'); } }), undefined);
  assert.equal(getAccountSource({ request: request('POST', {}, '', { 'X-Forwarded-For': '198.51.100.1' }) }), undefined);
  assert.equal(getAccountSource({ clientAddress: ' ' }), undefined);
});

test('来源A登录额度耗尽不影响来源B合法登录，切换用户名或伪造XFF不能恢复A额度', async () => {
  const f = fixture();
  await f.service.register(request('POST', credentials), '192.0.2.2');
  for (let i = 0; i < 100; i++) {
    await assert.rejects(f.service.login(request('POST', { username: `unknown_${i}`, password: credentials.password }), '192.0.2.1'), status(401));
  }
  await assert.rejects(f.service.login(request('POST', credentials, '', { 'X-Forwarded-For': '192.0.2.99' }), '192.0.2.1'), status(429));
  const result = await f.service.login(request('POST', credentials), '192.0.2.2');
  assert.equal(result.user.username, 'alice_123');
});

test('恶意空正文/空对象只耗尽来源A自身额度，不影响来源B登录注册', async () => {
  const f = fixture();
  await f.service.register(request('POST', credentials), '192.0.2.2');
  const before = f.calls.length;
  for (const [action, max] of [['login', 100], ['register', 30]]) {
    for (let i = 0; i < max; i++) {
      const body = i % 2 === 0 ? '{}' : '';
      const req = new Request(`${origin}/api/account/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body });
      await assert.rejects(f.service[action](req, '192.0.2.1'), status(400));
    }
    await assert.rejects(f.service[action](request('POST', credentials), '192.0.2.1'), status(429));
  }
  assert.equal(f.calls.length, before, '恶意无效正文未进入数据库');
  assert.equal((await f.service.login(request('POST', credentials), '192.0.2.2')).user.username, 'alice_123');
  assert.equal((await f.service.register(request('POST', { ...credentials, username: 'new_user' }), '192.0.2.2')).user.username, 'new_user');
});

test('用户名防爆破跨来源保留，且跨站请求不消耗来源或用户名额度', async () => {
  const f = fixture();
  await f.service.register(request('POST', credentials), '192.0.2.2');
  for (let i = 0; i < 10; i++) {
    await assert.rejects(f.service.login(request('POST', { ...credentials, password: 'wrong-password' }), `192.0.2.${i + 10}`), status(401));
  }
  await assert.rejects(f.service.login(request('POST', credentials), '192.0.2.2'), status(429));
  const other = fixture();
  await other.service.register(request('POST', credentials), '192.0.2.2');
  for (let i = 0; i < 101; i++) {
    await assert.rejects(other.service.login(request('POST', credentials, '', { Origin: 'https://evil.test' }), '192.0.2.2'), status(403));
  }
  assert.equal((await other.service.login(request('POST', credentials), '192.0.2.2')).user.username, 'alice_123');
});


// 仅使用测试进程中的虚构配置，不加载 .env，也不连接真实数据库。
function adminConfig(t, username = 'Deploy_Admin') {
  const keys = ['ADMIN_USERNAME', 'ADMIN_PASSWORD', 'ADMIN_TOKEN'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  }));
  process.env.ADMIN_USERNAME = username;
  process.env.ADMIN_PASSWORD = 'test-only-admin-password';
  delete process.env.ADMIN_TOKEN;
}

test('部署管理员名大小写不敏感保留，响应与普通重名一致且不写入用户或会话', async t => {
  adminConfig(t);
  const f = fixture();
  await f.service.register(request('POST', credentials));
  const duplicate = await api(() => f.service.register(request('POST', credentials)));
  const expected = await duplicate.json();
  for (const username of ['Deploy_Admin', 'deploy_admin', 'DEPLOY_ADMIN', 'dEpLoY_aDmIn']) {
    const before = f.calls.length;
    const response = await api(() => f.service.register(request('POST', { ...credentials, username })));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), expected);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(f.calls.length, before);
  }
  assert.equal(f.users().size, 1);
  assert.equal(f.sessions().size, 1);
});

test('保留名跟随部署配置且不依赖管理员密码，未配置时保留普通注册', async t => {
  adminConfig(t);
  const service = createAccountService({
    assertStorage() {}, limit() {},
    hash: async () => assert.fail('保留名不应开始密码哈希'),
    connection: async () => assert.fail('保留名不应访问数据库'),
  });
  delete process.env.ADMIN_PASSWORD;
  await assert.rejects(service.register(request('POST', { ...credentials, username: 'deploy_admin' })), status(409));
  process.env.ADMIN_USERNAME = ' Next_Admin ';
  await assert.rejects(service.register(request('POST', { ...credentials, username: 'NEXT_ADMIN' })), status(409));
  assert.equal((await fixture().service.register(request('POST', { ...credentials, username: 'deploy_admin' }))).user.username, 'deploy_admin');
  for (const name of [undefined, '', '   ']) {
    if (name === undefined) delete process.env.ADMIN_USERNAME;
    else process.env.ADMIN_USERNAME = name;
    assert.equal((await fixture().service.register(request('POST', credentials))).user.username, 'alice_123');
  }
});

test('注册携带提权字段仍只有普通身份，两套会话不能互换且退出互不影响', async t => {
  adminConfig(t);
  const f = fixture();
  const registered = await f.service.register(request('POST', {
    ...credentials, role: 'admin', isAdmin: true, permissions: ['admin'],
  }));
  assert.deepEqual(Object.keys(registered.user).sort(), ['id', 'username']);
  const userCookie = registered.cookie.split(';')[0];
  assert.equal(getAdminSession(request('GET', undefined, userCookie)), null);
  assert.throws(() => requireAdmin(request('GET', undefined, userCookie)), status(401));
  await assert.rejects(loginAdmin(request('POST', credentials)), status(401));
  const admin = await loginAdmin(request('POST', {
    username: 'Deploy_Admin', password: 'test-only-admin-password',
  }));
  const adminCookie = admin.cookie.split(';')[0];
  assert.equal(await f.service.getUser(request('GET', undefined, adminCookie)), null);
  assert.equal(getAdminSession(request('GET', undefined, userCookie.replace('nav_user_session=', 'admin_session='))), null);
  assert.equal(await f.service.getUser(request('GET', undefined, adminCookie.replace('admin_session=', 'nav_user_session='))), null);
  const both = `${userCookie}; ${adminCookie}`;
  assert.doesNotThrow(() => requireAdmin(request('GET', undefined, both)));
  assert.deepEqual(await f.service.getUser(request('GET', undefined, both)), registered.user);
  await f.service.logout(request('DELETE', undefined, both));
  assert.deepEqual(getAdminSession(request('GET', undefined, both)), { username: 'Deploy_Admin' });
  const loggedIn = await f.service.login(request('POST', credentials));
  const newUserCookie = loggedIn.cookie.split(';')[0];
  logoutAdmin(request('DELETE', undefined, `${newUserCookie}; ${adminCookie}`));
  assert.equal(getAdminSession(request('GET', undefined, adminCookie)), null);
  assert.deepEqual(await f.service.getUser(request('GET', undefined, newUserCookie)), registered.user);
});

test('历史普通账号与新部署管理员同名仍不能取得管理员权限', async t => {
  adminConfig(t);
  const f = fixture();
  await f.service.register(request('POST', credentials));
  process.env.ADMIN_USERNAME = credentials.username;
  const login = await f.service.login(request('POST', credentials));
  assert.throws(() => requireAdmin(request('GET', undefined, login.cookie.split(';')[0])), status(401));
  await assert.rejects(loginAdmin(request('POST', credentials)), status(401));
  await assert.rejects(f.service.register(request('POST', credentials)), status(409));
});

test('管理员登录页明确不开放注册且无注册入口或配置插值', async () => {
  const page = await readFile(new URL('../src/pages/admin/login.astro', import.meta.url), 'utf8');
  assert.match(page, /管理员账号仅由部署配置内置，不开放注册/);
  assert.match(page, /普通用户注册不会获得管理权限/);
  assert.doesNotMatch(page, /ADMIN_USERNAME|ADMIN_PASSWORD|process\.env|import\.meta\.env|href=["'][^"']*register|data-account-open=["']register/);
});
