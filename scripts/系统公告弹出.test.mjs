import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as view from '../src/lib/notification-view.ts';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element {
  dataset = {}; listeners = new Map(); attributes = {}; hidden = false; textContent = '';
  addEventListener(type, callback) {
    const list = this.listeners.get(type) ?? [];
    list.push(callback); this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter(fn => fn !== callback));
  }
  fire(type, extra = {}) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this, preventDefault() {}, ...extra });
  }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'hidden') this.hidden = true; }
  removeAttribute(key) { delete this.attributes[key]; if (key === 'hidden') this.hidden = false; }
  set innerHTML(_value) { throw new Error('公告必须使用 textContent，不能写入 innerHTML'); }
}
function clock() {
  let now = 0; let sequence = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, delay) { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next; now = timer.at; timers.delete(id); timer.fn();
      }
      now = end;
    },
  };
}
const item = (kind = 'announcement', extra = {}) => ({ id: 'a-1', kind, title: '公告标题', body: '公告正文', createdAt: '2026-09-07T10:00:00.000Z', ...extra });
const response = (items = [], status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => ({ data: { items, total: items.length, page: 1, pageSize: 1 } }) });
function toast() {
  const root = new Element(); root.hidden = true;
  const title = new Element(); const body = new Element(); const close = new Element();
  const nodes = new Map([
    ['[data-announcement-toast]', root], ['[data-announcement-toast-title]', title],
    ['[data-announcement-toast-body]', body], ['[data-announcement-toast-close]', close],
  ]);
  root.querySelector = selector => nodes.get(selector) ?? null;
  return { root, title, body, close, nodes };
}
async function setup(fetcher = async () => response([item()]), pathname = '/') {
  const code = ts.transpileModule(read('../src/scripts/announcement-toast.ts'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  let current = toast();
  const document = new Element(); document.querySelector = selector => current.nodes.get(selector) ?? null;
  document.readyState = 'complete';
  const window = new Element(); const location = new URL(pathname, 'http://localhost');
  const calls = []; const parserCalls = []; const errors = []; const time = clock();
  const fetch = async (url, options = {}) => { calls.push({ url, options }); return fetcher(url, options); };
  Object.assign(window, { location, document, fetch, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout });
  vm.runInNewContext(code, {
    exports: {}, require(name) {
      assert.match(name, /notification-view/);
      return { ...view, parseNotificationPage(value) { parserCalls.push(value); return view.parseNotificationPage(value); } };
    },
    document, window, location, URL, Element, HTMLElement: Element, HTMLButtonElement: Element,
    AbortController, fetch, setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
    console: { error: (...args) => errors.push(args), warn: (...args) => errors.push(args), log() {} },
  });
  await tick();
  return {
    ...current, document, window, location, calls, parserCalls, errors, time,
    navigate() { current = toast(); location.pathname = '/search/'; return current; },
  };
}
function assertSilent(c) {
  assert.equal(c.root.hidden, true);
  assert.equal(c.title.textContent, ''); assert.equal(c.body.textContent, '');
  assert.equal(c.time.timers.size, 0); assert.equal(c.errors.length, 0);
}

test('初始执行即请求最新公告，调用真实解析器并以纯文本显示标题和正文', async () => {
  const announcement = item('announcement', { title: '<script>alert(1)</script>', body: '<img src=x onerror=alert(1)>\n第二行' });
  const c = await setup(async () => response([announcement]));
  assert.equal(c.calls.length, 1);
  assert.equal(String(c.calls[0].url), '/api/notifications?kind=announcement&page=1&pageSize=1');
  assert.equal(c.calls[0].options.method ?? 'GET', 'GET');
  assert.ok(c.calls[0].options.signal instanceof AbortSignal);
  assert.equal(c.parserCalls.length, 1);
  assert.deepEqual(c.parserCalls[0], { items: [announcement], total: 1, page: 1, pageSize: 1 });
  assert.equal(c.root.hidden, false);
  assert.equal(c.title.textContent, announcement.title); assert.equal(c.body.textContent, announcement.body);
});

test('从显示时开始计时，2999ms仍显示，3000ms自动隐藏', async () => {
  let resolve;
  const c = await setup(() => new Promise(r => { resolve = r; }));
  c.time.advance(1000); assert.equal(c.root.hidden, true);
  resolve(response([item()])); await tick();
  assert.equal(c.root.hidden, false);
  c.time.advance(2999); assert.equal(c.root.hidden, false);
  c.time.advance(1); assert.equal(c.root.hidden, true);
  assert.equal(c.time.timers.size, 0);
});

test('手动关闭立即隐藏并清理自动关闭计时器，后续page-load不再弹出', async () => {
  const c = await setup();
  assert.equal(c.root.hidden, false);
  c.close.fire('click'); assert.equal(c.root.hidden, true);
  assert.equal(c.time.timers.size, 0);
  c.document.fire('astro:page-load'); await tick();
  c.time.advance(3000); assert.equal(c.root.hidden, true); assert.equal(c.calls.length, 1);
});

for (const [name, fetcher] of [
  ['空列表', async () => response()],
  ['空响应体', async () => ({ ok: true, status: 204, json: async () => { throw new SyntaxError('empty'); } })],
  ['缺失data', async () => ({ ok: true, status: 200, json: async () => ({}) })],
  ['data为null', async () => ({ ok: true, status: 200, json: async () => ({ data: null }) })],
  ['非法分页结构', async () => ({ ok: true, status: 200, json: async () => ({ data: { items: [item()], total: -1, page: 1, pageSize: 1 } }) })],
  ['非法公告字段', async () => response([item('announcement', { body: null })])],
  ['HTTP错误即使带公告', async () => response([item()], 503)],
  ['网络错误', async () => { throw new Error('offline'); }],
  ['JSON错误', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } })],
  ['站点消息', async () => response([item('site')])],
  ['私人提交消息', async () => response([item('submission')])],
  ['未知消息分类', async () => response([item('other')])],
]) {
  test(`${name}静默不弹，重复page-load不重试`, async () => {
    const c = await setup(fetcher); assertSilent(c);
    c.document.fire('astro:page-load'); await tick();
    assert.equal(c.calls.length, 1); assertSilent(c);
  });
}

test('请求进行中及完成后重复page-load都不重复请求，站内跳转也不重弹', async () => {
  let resolve;
  const c = await setup(() => new Promise(r => { resolve = r; }));
  c.document.fire('astro:page-load'); c.document.fire('astro:page-load'); await tick();
  assert.equal(c.calls.length, 1);
  resolve(response([item()])); await tick();
  c.document.fire('astro:page-load'); await tick(); assert.equal(c.calls.length, 1);
  c.document.fire('astro:before-swap'); assert.equal(c.root.hidden, true);
  const next = c.navigate(); c.document.fire('astro:page-load'); await tick();
  assert.equal(c.calls.length, 1); assert.equal(next.root.hidden, true);
  // 新的VM模拟浏览器整页刷新，允许重新请求。
  const refreshed = await setup(); assert.equal(refreshed.calls.length, 1); assert.equal(refreshed.root.hidden, false);
});

test('before-swap中止在途请求，即使fetch忽略abort且迟到也不能显示', async () => {
  let resolve;
  const c = await setup(() => new Promise(r => { resolve = r; }));
  assert.equal(c.calls.length, 1);
  c.document.fire('astro:before-swap');
  assert.equal(c.calls[0].options.signal.aborted, true);
  assert.equal(c.time.timers.size, 0); assert.equal(c.root.hidden, true);
  const next = c.navigate(); c.document.fire('astro:page-load');
  resolve(response([item()])); await tick();
  assert.equal(c.root.hidden, true); assert.equal(next.root.hidden, true);
  assert.equal(c.calls.length, 1); assert.equal(c.time.timers.size, 0);
});

test('before-swap发生在JSON解析等待期间，迟到正文也不能显示', async () => {
  let resolveJson;
  const c = await setup(async () => ({ ok: true, status: 200, json: () => new Promise(r => { resolveJson = r; }) }));
  assert.equal(typeof resolveJson, 'function');
  c.document.fire('astro:before-swap');
  resolveJson({ data: { items: [item()], total: 1, page: 1, pageSize: 1 } }); await tick();
  assert.equal(c.calls[0].options.signal.aborted, true);
  assert.equal(c.root.hidden, true); assert.equal(c.time.timers.size, 0);
});

test('公告显示后before-swap立即隐藏并清理timer', async () => {
  const c = await setup(); assert.equal(c.root.hidden, false); assert.ok(c.time.timers.size > 0);
  c.document.fire('astro:before-swap');
  assert.equal(c.root.hidden, true); assert.equal(c.time.timers.size, 0);
  c.time.advance(3000); assert.equal(c.root.hidden, true);
});

for (const pathname of ['/admin/', '/admin/announcements/', '/admin/login/']) {
  test(`后台路径${pathname}不请求也不弹公告`, async () => {
    const c = await setup(undefined, pathname);
    c.document.fire('astro:page-load'); await tick();
    assert.equal(c.calls.length, 0); assertSilent(c);
  });
}
