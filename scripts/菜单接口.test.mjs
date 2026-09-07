import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMenuSeed } from '../src/server/menu-seed.ts';
import { validateMenus, visibleMenus, menuRevision, sortMenus } from '../src/server/menu-validation.ts';
import { readMenuRequest } from '../src/server/menu-request.ts';
import { requireAdmin } from '../src/server/auth.ts';
import { HttpError } from '../src/server/http.ts';

const menu = (patch = {}) => ({ id: 'a', parentId: null, location: 'topbar', kind: 'link',
  label: '菜单', href: '/tools/', icon: 'lucide:house', sortOrder: 0, enabled: true, payload: {}, ...patch });
const group = (patch = {}) => menu({ id: 'g', kind: 'group', href: null, ...patch });
const category = (patch = {}) => menu({ location: 'sidebar', kind: 'category', href: '/#ai',
  payload: { homeAnchor: 'ai', categoryPath: '/ai/' }, ...patch });
const errorIs = (status, code) => error => error instanceof HttpError && error.status === status && error.code === code;
const invalid = value => assert.throws(() => validateMenus(value), errorIs(400, 'INVALID_MENU'));

// 仅导入静态种子和纯函数，不读取环境文件或调用仓储。
test('validateMenus 接受真实完整种子，排序且深拷贝 payload', () => {
  const seed = buildMenuSeed().menus;
  const before = structuredClone(seed);
  const actual = validateMenus(seed);
  assert.ok(actual.length > 0);
  assert.deepEqual(actual, sortMenus(seed));
  actual[0].payload.changed = true;
  assert.deepEqual(seed, before);
});

test('validateMenus 拒绝非数组、空数组、超过500条、未知或缺失字段', () => {
  for (const value of [null, {}, [], Array.from({ length: 501 }, (_, i) => menu({ id: `m${i}` })),
    [menu({ extra: true })], [{ ...menu(), parentId: undefined }]]) invalid(value);
});

test('validateMenus 拒绝重复ID、无父、自引用、循环、多层和跨区域父级', () => {
  for (const rows of [
    [menu(), menu()], [menu({ parentId: 'missing' })], [menu({ parentId: 'a' })],
    [menu({ parentId: 'b' }), menu({ id: 'b', parentId: 'a' })],
    [group(), group({ id: 'nested', parentId: 'g' }), menu({ parentId: 'nested' })],
    [group(), menu({ location: 'topbar-actions', parentId: 'g' })],
    [menu({ id: 'parent' }), menu({ parentId: 'parent' })],
  ]) invalid(rows);
});

for (const [field, values] of Object.entries({
  location: ['footer', '', null], kind: ['script', '', null],
  icon: ['lucide:does-not-exist-987654321', 'simple-icons:github', 'house', ''],
  sortOrder: [-1, 0.5, 1000001, '1', NaN, Infinity], enabled: [1, 'true', null],
})) test(`validateMenus 拒绝非法 ${field}`, () => {
  for (const value of values) invalid([menu({ [field]: value })]);
});

test('validateMenus 拒绝脚本、协议相对、反斜杠、凭据和空白URL', () => {
  for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', 'vbscript:x',
    '//evil.test/x', '/%2fevil.test', '/%5Cevil.test', '/\\evil.test', 'https://a:b@evil.test/',
    'https://good.test/\nx', ' /path', 'relative/path', '#ai', 'ftp://example.test']) invalid([menu({ href })]);
  for (const href of ['/tools/', '/#ai', 'https://example.test/a?b=c', 'http://example.test/'])
    assert.equal(validateMenus([menu({ href })])[0].href, href);
});

test('validateMenus 限制target和递归JSON污染属性', () => {
  for (const target of ['_parent', '_top', 'named-window', '', null, 42]) invalid([menu({ payload: { target } })]);
  for (const target of ['_self', '_blank']) assert.doesNotThrow(() => validateMenus([menu({ payload: { target } })]));
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    invalid([menu({ payload: JSON.parse(`{"nested":[{"${key}":{"polluted":true}}]}`) })]);
    invalid([JSON.parse(JSON.stringify(menu()).replace('"payload":{}', `"payload":{},"${key}":{}`))]);
  }
  assert.equal({}.polluted, undefined);
  for (const value of [undefined, NaN, Infinity, 1n, () => {}]) invalid([menu({ payload: { value } })]);
  invalid([menu({ payload: { value: 'x'.repeat(16001) } })]);
  let nested = {};
  for (let i = 0; i < 10; i++) nested = { nested };
  invalid([menu({ payload: nested })]);
});

test('安全回归：target 必须是字符串，不能用数组通过强转', () => {
  invalid([menu({ payload: { target: ['_blank'] } })]);
});

test('类型回归：location 不接受数组', () => {
  invalid([menu({ location: ['topbar'] })]);
});

test('validateMenus 分类锚点、路径、区域必须一致且不能污染普通链接', () => {
  assert.doesNotThrow(() => validateMenus([category()]));
  for (const patch of [{ href: '/#other' }, { href: '/ai/' }, { location: 'topbar' },
    { payload: { homeAnchor: 'other', categoryPath: '/ai/' } },
    { payload: { homeAnchor: 'ai', categoryPath: '/other/' } }, { payload: {} }]) invalid([category(patch)]);
  invalid([menu({ payload: { homeAnchor: 'ai' } })]);
  invalid([menu({ payload: { categoryPath: '/ai/' } })]);
});

test('validateMenus 排序稳定、范围边界以及侧栏个人排序键不可重复', () => {
  const rows = [menu({ id: 'z', sortOrder: 1 }), menu({ id: 'b' }), menu({ id: 'a' })];
  assert.deepEqual(validateMenus(rows).map(m => m.id), ['a', 'b', 'z']);
  assert.deepEqual(rows.map(m => m.id), ['z', 'b', 'a']);
  assert.doesNotThrow(() => validateMenus([menu({ sortOrder: 1000000 })]));
  invalid([menu({ location: 'sidebar', payload: { menuId: 'same' } }),
    menu({ id: 'b', location: 'sidebar', payload: { menuId: 'same' } })]);
  invalid([menu({ location: 'sidebar', payload: { menuId: 'b' } }), menu({ id: 'b', location: 'sidebar' })]);
});

test('validateMenus 资源仅允许topbar根分组下一级，侧栏不允许子项', () => {
  assert.doesNotThrow(() => validateMenus([group(), menu({ kind: 'resource', parentId: 'g' })]));
  invalid([menu({ kind: 'resource' })]);
  invalid([group({ location: 'topbar-actions' }), menu({ kind: 'resource', location: 'topbar-actions', parentId: 'g' })]);
  invalid([group({ location: 'sidebar' }), menu({ location: 'sidebar', parentId: 'g' })]);
  invalid([group({ href: '/bad/' })]);
});

test('visibleMenus 隐藏父级传递到启用子项、隐藏子项不影响父级且不修改输入', () => {
  const rows = validateMenus([group({ enabled: false }), menu({ parentId: 'g' }),
    group({ id: 'visible' }), menu({ id: 'off', parentId: 'visible', enabled: false }), menu({ id: 'root' })]);
  const before = structuredClone(rows);
  assert.deepEqual(visibleMenus(rows).map(m => m.id), ['root', 'visible']);
  assert.deepEqual(rows, before);
});

test('revision 忽略菜单输入顺序和递归JSON键顺序，但保留数组顺序', () => {
  const a = [menu({ payload: { z: 1, a: { y: 2, x: [1, 2] } } }), group()];
  const b = [group(), menu({ payload: { a: { x: [1, 2], y: 2 }, z: 1 } })];
  assert.match(menuRevision(a), /^[a-f0-9]{64}$/);
  assert.equal(menuRevision(a), menuRevision(b));
  b[1].payload.a.x.reverse();
  assert.notEqual(menuRevision(a), menuRevision(b));
});

test('revision 与每个持久化字段相关，包括隐藏菜单', () => {
  const original = menu();
  for (const [field, value] of Object.entries({ id: 'other', parentId: 'g', location: 'sidebar', kind: 'category',
    label: '更名', href: '/other/', icon: null, sortOrder: 1, enabled: false, payload: { description: '修改' } })) {
    assert.notEqual(menuRevision([original]), menuRevision([{ ...original, [field]: value }]), field);
  }
  assert.notEqual(menuRevision([menu({ enabled: false })]), menuRevision([menu({ enabled: false, label: '隐藏更名' })]));
});

const url = 'https://example.test/api/admin/menus';
const request = (body = '{"menus":[],"revision":"abc"}', headers = {}) =>
  new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body });

test('readMenuRequest 接受同源JSON、charset、无Origin的非浏览器请求', async () => {
  for (const headers of [{}, { origin: 'https://example.test' }, { 'content-type': 'Application/JSON; charset=utf-8' }]) {
    assert.deepEqual(await readMenuRequest(request(undefined, headers)), { menus: [], revision: 'abc' });
  }
});

test('readMenuRequest 拒绝跨源和错误content-type', async () => {
  for (const headers of [{ origin: 'https://evil.test' }, { origin: 'null' }, { origin: 'https://example.test:444' },
    { 'sec-fetch-site': 'cross-site' }]) await assert.rejects(readMenuRequest(request(undefined, headers)), errorIs(403, 'CROSS_ORIGIN_WRITE'));
  for (const type of ['', 'text/plain', 'application/jsonp', 'multipart/form-data'])
    await assert.rejects(readMenuRequest(request(undefined, { 'content-type': type })), errorIs(415, 'JSON_REQUIRED'));
});

test('readMenuRequest 拒绝坏JSON、非对象、未知键和缺少body', async () => {
  for (const body of ['', '{', '[]', 'null', 'true', '1', '"x"', '{"extra":1}', '{"__proto__":{}}'])
    await assert.rejects(readMenuRequest(request(body)), errorIs(400, 'INVALID_JSON'));
  await assert.rejects(readMenuRequest(request(null)), errorIs(400, 'INVALID_JSON'));
});

function streaming(chunks, headers = {}) {
  let index = 0;
  let cancelled = false;
  const body = new ReadableStream({
    pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]); else controller.close(); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  const req = new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body, duplex: 'half' });
  return { req, cancelled: () => cancelled };
}

test('readMenuRequest 限制Content-Length且逐块计数字节，不信任缺省/伪造长度', async () => {
  const limit = 512 * 1024;
  await assert.rejects(readMenuRequest(request('{}', { 'content-length': String(limit + 1) })), errorIs(413, 'MENU_BODY_TOO_LARGE'));
  for (const headers of [{}, { 'content-length': '1' }]) {
    const { req, cancelled } = streaming([new Uint8Array(limit - 1), new Uint8Array(2)], headers);
    await assert.rejects(readMenuRequest(req), errorIs(413, 'MENU_BODY_TOO_LARGE'));
    assert.equal(cancelled(), true);
    assert.equal(req.body.locked, false);
  }
  const exact = Buffer.from('{"revision":"' + 'a'.repeat(limit - 15) + '"}');
  assert.equal(exact.byteLength, limit);
  const { req } = streaming([exact.subarray(0, 99), exact.subarray(99)]);
  assert.equal((await readMenuRequest(req)).revision.length, limit - 15);
  assert.equal(req.body.locked, false);
});

test('readMenuRequest 支持拆分UTF-8字符并在读流错误时释放reader', async () => {
  const bytes = Buffer.from('{"revision":"中文"}');
  const { req } = streaming([...bytes].map(b => Uint8Array.of(b)));
  assert.deepEqual(await readMenuRequest(req), { revision: '中文' });
  const failure = new Error('stream failed');
  const bad = new Request(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, duplex: 'half',
    body: new ReadableStream({ pull(controller) { controller.error(failure); } }) });
  await assert.rejects(readMenuRequest(bad), error => error === failure);
  assert.equal(bad.body.locked, false);
});

test('菜单API鉴权依赖：仅接受正确Bearer头，不接受URL或Cookie凭据', () => {
  const token = 'menu-test-token-'.repeat(4);
  assert.doesNotThrow(() => requireAdmin(request('{}', { authorization: `Bearer ${token}` }), token));
  for (const headers of [{}, { cookie: `token=${token}` }, { authorization: `Basic ${token}` },
    { authorization: `Bearer ${'x'.repeat(64)}` }]) assert.throws(() => requireAdmin(request('{}', headers), token), errorIs(401, 'UNAUTHORIZED'));
  assert.throws(() => requireAdmin(new Request(`${url}?token=${token}`), token), errorIs(401, 'UNAUTHORIZED'));
  assert.throws(() => requireAdmin(request(), ''), errorIs(503, 'ADMIN_NOT_CONFIGURED'));
});

test('类型回归：kind 不接受数组，防止绕过group/resource专项校验', () => {
  for (const kind of [['link'], ['group'], ['resource']]) invalid([menu({ kind })]);
});

test('菜单排序依次考虑区域、父ID、sortOrder和ID，revision不因输入洗牌变化', () => {
  const rows = validateMenus([menu({ id: 'child-b', parentId: 'g', sortOrder: 0 }),
    menu({ id: 'action', location: 'topbar-actions' }), group({ sortOrder: 50 }),
    menu({ id: 'sidebar', location: 'sidebar' }), menu({ id: 'root', sortOrder: 1 }),
    menu({ id: 'child-a', parentId: 'g', sortOrder: 0 })]);
  assert.deepEqual(rows.map(m => m.id), ['sidebar', 'root', 'g', 'child-a', 'child-b', 'action']);
  assert.equal(menuRevision(rows), menuRevision([...rows].reverse()));
});

test('readMenuRequest 限额按UTF-8字节而非字符计算', async () => {
  const text = JSON.stringify({ revision: '中'.repeat(180000) });
  assert.ok(text.length < 512 * 1024);
  assert.ok(Buffer.byteLength(text) > 512 * 1024);
  await assert.rejects(readMenuRequest(request(text)), errorIs(413, 'MENU_BODY_TOO_LARGE'));
});
