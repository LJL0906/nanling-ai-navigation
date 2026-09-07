import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPersonalApi, LoginRequiredError, requestPersonalAuth } from '../src/scripts/personal-api.ts';
import { PERSONAL_KEYS } from '../src/lib/personal-store.ts';

const record = (siteId, visitType) => ({ siteId, updatedAt: '2026-09-07T10:00:00.000Z', ...(visitType ? { visitType } : {}) });
const empty = () => ({ favorites: [], history: [] });
const reply = (data = empty(), status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data }) });
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup(handler = () => reply(), seed = {}) {
  const values = new Map(Object.entries(seed));
  const calls = [];
  const snapshots = [];
  let broadcasts = 0;
  const api = createPersonalApi({
    fetch: async (url, options) => {
      const call = { url, ...options, action: options.body ? JSON.parse(options.body) : undefined };
      calls.push(call);
      return handler(call, calls.length);
    },
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    changed: () => snapshots.push(api.snapshot()), broadcast: () => broadcasts++,
  });
  return { api, calls, values, snapshots, broadcasts: () => broadcasts };
}

test('初次读取后导入两个旧键，确认前不删除也不假装同步完成', async () => {
  const gate = deferred();
  const favorites = [record('site_a')]; const history = [record('site_b', 'detail')];
  const ctx = setup((call) => call.action ? gate.promise : reply(), {
    [PERSONAL_KEYS.favorites]: JSON.stringify(favorites), [PERSONAL_KEYS.history]: JSON.stringify(history),
  });
  const task = ctx.api.ensure(); await tick();
  assert.deepEqual(ctx.calls.map((call) => call.method), ['GET', 'POST']);
  assert.deepEqual(ctx.calls[1].action, { action: 'import', favorites, history });
  assert.equal(ctx.values.size, 2); assert.equal(ctx.api.snapshot().pending, 1);
  gate.resolve(reply({ favorites, history })); await task;
  assert.equal(ctx.values.size, 0); assert.deepEqual(ctx.api.read('favorites'), favorites);
  assert.equal(ctx.api.snapshot().status, 'ready'); assert.equal(ctx.broadcasts(), 1);
});

test('导入失败保留旧记录并展示错误，重试先GET再导入', async () => {
  let fail = true;
  const seed = { [PERSONAL_KEYS.favorites]: JSON.stringify([record('site_a')]) };
  const ctx = setup((call) => call.action && fail ? reply(null, 503) : reply(), seed);
  await assert.rejects(ctx.api.ensure(), /503/);
  assert.equal(ctx.values.get(PERSONAL_KEYS.favorites), seed[PERSONAL_KEYS.favorites]);
  assert.equal(ctx.api.snapshot().status, 'error'); assert.match(ctx.api.snapshot().error, /503/);
  fail = false; await ctx.api.ensure();
  assert.deepEqual(ctx.calls.map((call) => call.method), ['GET', 'POST', 'GET', 'POST']);
  assert.equal(ctx.values.size, 0);
});

test('GET网络故障不导入、不删除旧记录，也不发送收藏写入', async () => {
  const ctx = setup(() => { throw new Error('网络断开'); }, { [PERSONAL_KEYS.history]: '[]' });
  await assert.rejects(ctx.api.toggleFavorite('site_a'), /网络断开/);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.values.size, 1);
  assert.equal(ctx.api.snapshot().pending, 0);
});

test('401是登录状态而非弹错；未登录访问不POST也不新增本地，收藏拒绝且保留旧数据', async () => {
  const ctx = setup(() => reply(null, 401), { [PERSONAL_KEYS.favorites]: JSON.stringify([record('site_a')]) });
  await ctx.api.ensure(); await ctx.api.ensure();
  await ctx.api.recordVisit('site_b', 'external'); await ctx.api.recordVisit('site_c', 'detail');
  await assert.rejects(ctx.api.toggleFavorite('site_a'), LoginRequiredError);
  assert.equal(ctx.calls.length, 1); assert.equal(ctx.api.snapshot().status, 'signed-out');
  assert.equal(ctx.api.snapshot().error, ''); assert.deepEqual(ctx.api.read('favorites'), []);
  assert.equal(ctx.values.has(PERSONAL_KEYS.history), false);
  assert.ok(ctx.values.has(PERSONAL_KEYS.favorites));
});

test('登录后刷新仅导入历史已有本地数据，不导入未登录时访问', async () => {
  let loggedIn = false;
  const ctx = setup((call) => !loggedIn ? reply(null, 401) : reply(call.action?.action === 'import' ? call.action : empty()),
    { [PERSONAL_KEYS.history]: JSON.stringify([record('site_legacy', 'detail')]) });
  await ctx.api.recordVisit('site_b', 'external');
  loggedIn = true; await ctx.api.refresh();
  assert.deepEqual(ctx.calls.map((call) => call.action?.action ?? 'GET'), ['GET', 'GET', 'import']);
  assert.equal(ctx.api.read('history')[0].siteId, 'site_legacy'); assert.equal(ctx.values.size, 0);
});

test('首次外链访问GET及visit启用keepalive，导入关闭且确认后才写visit', async () => {
  const ctx = setup(() => reply(), { [PERSONAL_KEYS.favorites]: '[]' });
  await ctx.api.recordVisit('site_a', 'external');
  assert.deepEqual(ctx.calls.map((call) => call.action?.action ?? 'GET'), ['GET', 'import', 'visit']);
  for (const call of ctx.calls) {
    assert.equal(call.keepalive, call.action?.action !== 'import'); assert.equal(call.credentials, 'same-origin'); assert.equal(call.cache, 'no-store');
  }
  assert.deepEqual(ctx.calls[2].action, { action: 'visit', siteId: 'site_a', visitType: 'external' });
});

test('并发收藏串行，初始读取后计算selected，服务端确认之前UI数据不变', async () => {
  const gate = deferred(); let posts = 0;
  const ctx = setup((call) => {
    if (!call.action) return reply({ favorites: [record('site_a')], history: [] });
    return ++posts === 1 ? gate.promise : reply({ favorites: [record('site_a')], history: [] });
  });
  const first = ctx.api.toggleFavorite('site_a'); const second = ctx.api.toggleFavorite('site_a');
  await tick(); assert.equal(ctx.calls.length, 2); assert.equal(ctx.calls[1].action.selected, false);
  assert.equal(ctx.api.read('favorites').length, 1); assert.equal(ctx.api.snapshot().pending, 2);
  gate.resolve(reply()); await Promise.all([first, second]);
  assert.equal(ctx.calls[2].action.selected, true); assert.equal(ctx.api.snapshot().pending, 0);
});

test('写入失败不更新快照不广播，队列可恢复', async () => {
  let fail = true;
  const ctx = setup((call) => !call.action ? reply({ favorites: [record('site_a')], history: [] }) : fail ? reply(null, 500) : reply());
  await ctx.api.ensure(); await assert.rejects(ctx.api.clear('favorites'), /500/);
  assert.equal(ctx.api.read('favorites').length, 1); assert.equal(ctx.broadcasts(), 0);
  fail = false; await ctx.api.remove('favorites', 'site_a');
  assert.equal(ctx.api.read('favorites').length, 0); assert.equal(ctx.broadcasts(), 1);
  assert.equal(ctx.api.snapshot().error, '');
});

test('remove和clear符合契约且使用返回的完整快照', async () => {
  const ctx = setup((call) => reply(call.action ? { favorites: [], history: [record('site_b', 'detail')] } : empty()));
  await ctx.api.remove('favorites', 'site_a'); await ctx.api.clear('history');
  assert.deepEqual(ctx.calls[1].action, { action: 'remove', kind: 'favorites', siteId: 'site_a' });
  assert.deepEqual(ctx.calls[2].action, { action: 'clear', kind: 'history' });
  assert.equal(ctx.api.read('history').length, 1);
});

test('写入遇到session过期清除账号快照，visit丢弃不写本地、不重复发POST', async () => {
  const ctx = setup((call) => call.action ? reply(null, 401) : reply({ favorites: [record('site_a')], history: [] }));
  await ctx.api.ensure(); await ctx.api.recordVisit('site_b', 'detail'); await ctx.api.recordVisit('site_c', 'external');
  assert.equal(ctx.calls.length, 2); assert.deepEqual(ctx.api.read('favorites'), []);
  assert.equal(ctx.api.snapshot().status, 'signed-out'); assert.equal(ctx.api.snapshot().error, '');
  assert.equal(ctx.values.has(PERSONAL_KEYS.history), false);
});

test('刷新与写入串行，避免迟到GET覆盖已确认写入', async () => {
  const gate = deferred();
  const ctx = setup((call, index) => index === 2 ? gate.promise : reply());
  await ctx.api.ensure();
  const refresh = ctx.api.refresh(); const write = ctx.api.clear('history');
  await tick(); assert.equal(ctx.calls.length, 2);
  gate.resolve(reply()); await Promise.all([refresh, write]);
  assert.equal(ctx.calls[2].action.action, 'clear');
});

test('错误响应结构不得当作空列表成功，也不得删除迁移记录', async () => {
  const ctx = setup((call) => call.action ? reply({ favorites: 'bad', history: [] }) : reply(), { [PERSONAL_KEYS.history]: '[]' });
  await assert.rejects(ctx.api.ensure(), /格式错误/); assert.equal(ctx.values.size, 1);
  assert.equal(ctx.broadcasts(), 0);
});

test('导入期间其他标签页新增的本地数据不被移除', async () => {
  const gate = deferred();
  const ctx = setup((call) => call.action ? gate.promise : reply(), { [PERSONAL_KEYS.history]: '[]' });
  const task = ctx.api.ensure(); await tick();
  const newer = JSON.stringify([record('site_b', 'external')]); ctx.values.set(PERSONAL_KEYS.history, newer);
  gate.resolve(reply()); await task;
  assert.equal(ctx.values.get(PERSONAL_KEYS.history), newer);
});

test('浏览器禁止本地存储时告警跳过迁移，服务器读取和收藏仍正常', async () => {
  const actions = [];
  const api = createPersonalApi({ fetch: async (_url, options) => {
    actions.push(options.body ? JSON.parse(options.body) : 'GET');
    return reply({ favorites: [record('site_a')], history: [] });
  }, storage: {
    getItem: () => { throw new Error('存储权限不足'); }, setItem() {}, removeItem() {},
  } });
  await api.ensure();
  assert.equal(api.snapshot().status, 'ready'); assert.equal(api.snapshot().error, '');
  assert.match(api.snapshot().warning, /存储权限不足/);
  assert.equal(api.read('favorites')[0].siteId, 'site_a');
  await api.toggleFavorite('site_b'); await api.clear('history');
  assert.deepEqual(actions, ['GET', { action: 'favorite', siteId: 'site_b', selected: true }, { action: 'clear', kind: 'history' }]);
  assert.equal(api.snapshot().status, 'ready');
});

test('登录请求派发document事件，仅传reason不包含跳转或回调', () => {
  const previous = globalThis.document;
  const target = new EventTarget();
  globalThis.document = target;
  const reasons = [];
  target.addEventListener('nav:auth-required', (event) => reasons.push(event.detail));
  try {
    requestPersonalAuth('favorite'); requestPersonalAuth('personal');
    assert.deepEqual(reasons, [{ reason: 'favorite' }, { reason: 'personal' }]);
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('页面提供登录、重试与错误区域，文案为账号同步；前端不使用storage事件同步旧快照', async () => {
  const page = await readFile(new URL('../src/components/layout/PersonalPage.astro', import.meta.url), 'utf8');
  const script = await readFile(new URL('../src/scripts/personal.ts', import.meta.url), 'utf8');
  assert.match(page, /data-personal-login/); assert.match(page, /data-personal-error-message/);
  assert.match(page, /跨设备同步/); assert.doesNotMatch(page, /href="\/login/);
  assert.match(page, /未登录不记录访问/); assert.doesNotMatch(page, /匿名|无需登录|仅保存在当前浏览器/);
  assert.match(script, /BroadcastChannel/); assert.doesNotMatch(script, /addEventListener\('storage'/);
  assert.match(script, /if \(sameTab\) event.preventDefault\(\)/);
  assert.match(script, /visit.finally/);
  assert.match(script, /nav:account-changed/); assert.doesNotMatch(script, /localStorage.setItem|personalLoginHref|\/login\//);
  const pageScript = await readFile(new URL('../src/scripts/personal-page.ts', import.meta.url), 'utf8');
  assert.match(pageScript, /state.pending === 0 && !authPrompted/);
  assert.match(pageScript, /requestPersonalAuth\('personal'\)/);
});

test('损坏旧数据保留原键且告警，但不阻断服务器收藏和列表', async () => {
  for (const raw of ['{invalid', '{}', '[{"siteId":"bad","updatedAt":"yesterday"}]']) {
    const ctx = setup(() => reply(), { [PERSONAL_KEYS.favorites]: raw });
    await ctx.api.ensure();
    assert.match(ctx.api.snapshot().warning, /本地旧记录/); assert.equal(ctx.api.snapshot().status, 'ready');
    assert.equal(ctx.values.get(PERSONAL_KEYS.favorites), raw); assert.equal(ctx.calls.length, 1);
    await ctx.api.toggleFavorite('site_a');
    assert.equal(ctx.calls[1].action.action, 'favorite');
    assert.equal(ctx.values.get(PERSONAL_KEYS.favorites), raw);
    assert.equal(ctx.api.snapshot().status, 'ready');
  }
});

test('收藏POST遇到401不能显示成功且不改变为本地收藏', async () => {
  const ctx = setup((call) => call.action ? reply(null, 401) : reply());
  await assert.rejects(ctx.api.toggleFavorite('site_a'), LoginRequiredError);
  assert.equal(ctx.values.size, 0); assert.equal(ctx.broadcasts(), 0);
  assert.equal(ctx.api.snapshot().status, 'signed-out');
});

test('退出后刷新清空服务端快照，无需删除或重写本地存储', async () => {
  let signedOut = false;
  const ctx = setup(() => signedOut ? reply(null, 401) : reply({ favorites: [record('site_a')], history: [] }));
  await ctx.api.ensure(); signedOut = true; await ctx.api.refresh();
  assert.equal(ctx.api.read('favorites').length, 0); assert.equal(ctx.api.snapshot().error, '');
  assert.equal(ctx.api.snapshot().status, 'signed-out');
});

// 用独立VM执行真实personal.ts，验证捕获阶段路由门控，不依赖浏览器或后端。
async function navigationHarness(initialStatus = 'signed-out') {
  const { default: ts } = await import('typescript');
  const { runInNewContext } = await import('node:vm');
  const source = await readFile(new URL('../src/scripts/personal.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const listeners = new Map(); const prompts = []; const navigations = [];
  const state = { data: empty(), status: initialStatus, pending: 0, error: '' };
  let ensureCalls = 0; let refreshCalls = 0;
  let ensureWork = async () => {}; let refreshWork = async () => {};
  const api = {
    snapshot: () => state, read: (kind) => state.data[kind],
    toggleFavorite: async () => { throw new LoginRequiredError(); },
    ensure: () => { ensureCalls++; return ensureWork(); },
    refresh: () => { refreshCalls++; return refreshWork(); },
  };
  const document = {
    querySelector: () => null, querySelectorAll: () => [], body: {},
    addEventListener: (name, handler, capture) => {
      const list = listeners.get(name) ?? []; list.push({ handler, capture }); listeners.set(name, list);
    },
    dispatchEvent: (event) => { for (const item of listeners.get(event.type) ?? []) item.handler(event); return true; },
  };
  runInNewContext(javascript, {
    exports: {}, require: (name) => {
      if (name === './personal-api') return { createPersonalApi: () => api, LoginRequiredError,
        requestPersonalAuth: (reason) => prompts.push(reason) };
      if (name === './personal-catalog') return { loadPersonalSites: async () => new Map() };
      throw new Error(`Unexpected import: ${name}`);
    },
    document, window: { addEventListener() {} },
    location: { origin: 'https://nav.test', href: 'https://nav.test/', assign: (path) => navigations.push(path) },
    MutationObserver: class { observe() {} disconnect() {} },
    cancelAnimationFrame() {}, requestAnimationFrame() { return 1; }, URL, CustomEvent, setTimeout, clearTimeout,
  });
  function click(path, options = {}) {
    const link = { href: new URL(path, 'https://nav.test').href, target: options.target ?? '',
      hasAttribute: (name) => name === 'download' && options.download,
      closest: () => null, classList: { contains: () => false } };
    const event = { type: 'click', button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      defaultPrevented: false, ...options, target: { closest: (selector) => selector === 'a[href]' ? link : null },
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    const handlers = [...(listeners.get('click') ?? [])].sort((a, b) => Number(Boolean(b.capture)) - Number(Boolean(a.capture)));
    for (const { handler } of handlers) handler(event);
    return event;
  }
  async function favorite() {
    const button = { disabled: false, dataset: { favoriteId: 'site_a' } };
    const event = { type: 'click', button: 0, defaultPrevented: false,
      target: { closest: (selector) => selector === '[data-favorite-id]' ? button : null },
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const { handler } of listeners.get('click') ?? []) await handler(event);
  }
  return { state, prompts, navigations, click, favorite, document,
    ensureCalls: () => ensureCalls, refreshCalls: () => refreshCalls,
    setEnsure: (work) => { ensureWork = work; }, setRefresh: (work) => { refreshWork = work; } };
}

test('真实导航事件：未登录点击收藏/历史入口原地弹框，账号变更后先刷新再去待访问页', async () => {
  const ui = await navigationHarness();
  assert.equal(ui.prompts.length, 0, '首页初始化不能自动弹登录');
  const event = ui.click('/favorites/?q=abc#list');
  assert.equal(event.defaultPrevented, true); assert.deepEqual(ui.prompts, ['personal']);
  assert.equal(ui.navigations.length, 0);
  const gate = deferred(); ui.setRefresh(async () => { await gate.promise; ui.state.status = 'ready'; });
  ui.document.dispatchEvent(new CustomEvent('nav:account-changed'));
  assert.equal(ui.refreshCalls(), 1); assert.equal(ui.navigations.length, 0);
  gate.resolve(); await tick();
  assert.deepEqual(ui.navigations, ['/favorites/?q=abc#list']);
});

test('真实导航事件：未知身份阻止跳转，等GET确认；401弹框，登录态正常放行', async () => {
  const ui = await navigationHarness('idle'); const gate = deferred();
  ui.setEnsure(async () => { await gate.promise; ui.state.status = 'signed-out'; });
  assert.equal(ui.click('/history/').defaultPrevented, true);
  assert.equal(ui.prompts.length, 0); assert.equal(ui.navigations.length, 0);
  gate.resolve(); await tick(); assert.deepEqual(ui.prompts, ['personal']);
  const authenticated = await navigationHarness('ready');
  assert.equal(authenticated.click('/history/').defaultPrevented, false);
  assert.equal(authenticated.prompts.length, 0);
  const unknown = await navigationHarness('idle');
  unknown.setEnsure(async () => { unknown.state.status = 'ready'; });
  assert.equal(unknown.click('/favorites/').defaultPrevented, true);
  await tick(); assert.deepEqual(unknown.navigations, ['/favorites/']);
});

test('真实导航事件：Ctrl/Meta/Shift/Alt、中键、新窗口、下载和外部同名路径均不拦截', async () => {
  const ui = await navigationHarness();
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true },
    { button: 1 }, { target: '_blank' }, { download: true }]) {
    assert.equal(ui.click('/favorites/', options).defaultPrevented, false);
  }
  assert.equal(ui.click('https://external.test/history/').defaultPrevented, false);
  assert.equal(ui.prompts.length, 0);
});

test('真实导航事件：提交站点及其他入口不受门控，后续页面切换清除待去路径', async () => {
  const ui = await navigationHarness();
  for (const path of ['/submit/', '/api/submissions', '/settings/', '/categories/', '/login/', '/favorites/example/']) {
    assert.equal(ui.click(path).defaultPrevented, false);
  }
  assert.equal(ui.prompts.length, 0);
  ui.click('/history/'); ui.document.dispatchEvent(new CustomEvent('astro:before-swap'));
  ui.setRefresh(async () => { ui.state.status = 'ready'; });
  ui.document.dispatchEvent(new CustomEvent('nav:account-changed')); await tick();
  assert.equal(ui.navigations.length, 0);
});


test('真实收藏事件：未登录主动点击只触发favorite弹窗，不跳登录页也不显示收藏成功', async () => {
  const ui = await navigationHarness();
  await ui.favorite();
  assert.deepEqual(ui.prompts, ['favorite']);
  assert.deepEqual(ui.navigations, []);
  assert.deepEqual(ui.state.data.favorites, []);
});


test('大于64KiB迁移关闭keepalive，GET与小写入保留keepalive', async () => {
  const favorites = Array.from({ length: 1200 }, (_, index) => record(`site_${index}`));
  const ctx = setup((call) => {
    if (call.body && Buffer.byteLength(call.body) > 65536 && call.keepalive) throw new TypeError('keepalive body too large');
    return reply({ favorites, history: [] });
  }, { [PERSONAL_KEYS.favorites]: JSON.stringify(favorites) });
  await ctx.api.ensure(); await ctx.api.toggleFavorite('site_new');
  assert.ok(Buffer.byteLength(ctx.calls[1].body) > 65536);
  assert.equal(ctx.calls[1].action.action, 'import'); assert.equal(ctx.calls[1].keepalive, false);
  assert.equal(ctx.calls[0].keepalive, true); assert.equal(ctx.calls[2].keepalive, true);
  assert.equal(ctx.values.size, 0); assert.equal(ctx.api.snapshot().status, 'ready');
});

test('迁移确认后旧键清理受限只告警，不阻断后续服务器写入', async () => {
  let calls = 0; const raw = JSON.stringify([record('site_a')]);
  const api = createPersonalApi({ fetch: async () => { calls++; return reply(); }, storage: {
    getItem: (key) => key === PERSONAL_KEYS.favorites ? raw : null,
    setItem() { throw new Error('禁止写入'); }, removeItem() { throw new Error('禁止删除'); },
  } });
  await api.ensure();
  assert.equal(api.snapshot().status, 'ready'); assert.match(api.snapshot().warning, /清理失败/);
  await api.clear('favorites'); assert.equal(calls, 3); assert.equal(api.snapshot().error, '');
});
