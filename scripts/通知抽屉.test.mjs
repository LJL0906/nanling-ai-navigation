import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as view from '../src/lib/notification-view.ts';
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const code = ts.transpileModule(read('../src/scripts/notifications.ts'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element {
  dataset = {}; children = []; listeners = new Map(); attributes = {}; hidden = false; disabled = false; textContent = ''; open = false;
  addEventListener(type, callback) { const list = this.listeners.get(type) ?? []; list.push(callback); this.listeners.set(type, list); }
  removeEventListener(type, callback) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(fn => fn !== callback)); }
  fire(type, extra = {}) { const event = { target: this, preventDefault() {}, ...extra }; for (const fn of this.listeners.get(type) ?? []) fn(event); }
  dispatchEvent(event) { this.fire(event.type, event); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  closest() { return null; }
  showModal() { this.open = true; }
  close() { this.open = false; this.fire('close'); }
  getBoundingClientRect() { return { left: 400, right: 900, top: 0, bottom: 800 }; }
}
const response = (items = [], status = 200, extra = {}) => ({ status, ok: status < 400, json: async () => ({ data: { items, total: items.length, page: 1, pageSize: 20, ...extra }, ...(status >= 400 ? { error: { message: '请求失败' } } : {}) }) });
const item = (kind = 'site', extra = {}) => ({ id: 'n-1', kind, title: '站点消息', body: '内容', createdAt: '2026-09-07T10:00:00.000Z', ...extra });
async function setup(fetcher = async () => response(), query = '?notifications=site') {
  const nodes = new Map(); const el = name => { if (!nodes.has(name)) nodes.set(name, new Element()); return nodes.get(name); };
  const root = new Element(); const tabs = ['site','submission','announcement'].map(kind => { const tab = new Element(); tab.dataset.notificationKind = kind; return tab; });
  root.querySelector = selector => el(selector); root.querySelectorAll = () => tabs;
  const document = new Element(); document.querySelector = () => root; document.createElement = () => new Element(); document.documentElement = { style: { overflow: '' } };
  const window = new Element(); const calls = []; const location = new URL('http://localhost/' + query);
  vm.runInNewContext(code, { exports: {}, require: name => name.includes('notification-view') ? view : { initializeAccountEvents() {} },
    document, window, location, history: { replaceState(_a,_b,url) { location.href = url.href; } }, URL, Element, AbortController, setTimeout, clearTimeout,
    CustomEvent: class { constructor(type, options = {}) { this.type = type; Object.assign(this, options); } },
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
  });
  await tick(); return { root, tabs, document, window, calls, el, location };
}
test('通知抽屉只保留三类切换、列表与必要控件，没有页面大标题和解释tips', () => {
  const component = read('../src/components/layout/NotificationDrawer.astro');
  assert.match(component, /<dialog/); assert.doesNotMatch(component, /<h1|通知中心|历史匿名|仅本人可见/);
  assert.equal((component.match(/data-notification-kind=/g) ?? []).length, 3);
  assert.match(read('../src/layouts/BaseLayout.astro'), /<NotificationDrawer/);
  assert.match(read('../src/pages/notifications/index.astro'), /Astro.redirect/);
});
test('默认页面不请求通知；深链打开右侧抽屉并消费URL参数', async () => {
  const closed = await setup(undefined, ''); assert.equal(closed.calls.length, 0); assert.equal(closed.root.open, false);
  const open = await setup(); assert.equal(open.calls.length, 1); assert.equal(open.root.open, true);
  assert.equal(open.location.search, ''); assert.equal(open.document.documentElement.style.overflow, 'hidden');
});
test('站点消息作为纯文本渲染，单页隐藏分页，不执行HTML', async () => {
  const c = await setup(async () => response([item('site', { title: '<script>alert(1)</script>' })]));
  const rows = c.el('[data-notification-list]').children;
  assert.equal(rows.length, 1); assert.equal(rows[0].children[0].children[0].textContent, '<script>alert(1)</script>');
  assert.equal(c.el('[data-notification-pagination]').hidden, true);
});
test('私人401只显示登录入口，不显示伪空数据，登录前先关闭抽屉', async () => {
  const c = await setup(async () => response([], 401), '?notifications=submission');
  assert.equal(c.el('[data-notification-login]').hidden, false);
  assert.equal(c.el('[data-notification-message]').textContent, '');
  let auth = 0; c.document.addEventListener('nav:auth-required', () => auth++);
  c.el('[data-notification-login-action]').fire('click');
  assert.equal(c.root.open, false); assert.equal(auth, 1); assert.equal(c.document.documentElement.style.overflow, '');
});
test('切换分类立即清空旧消息，迟到请求不能覆盖当前分类', async () => {
  let resolve; let n = 0;
  const c = await setup(async () => ++n === 1 ? new Promise(r => { resolve = r; }) : response([item('announcement')]));
  c.tabs[2].fire('click'); await tick();
  resolve(response([item('site')])); await tick();
  const rows = c.el('[data-notification-list]').children;
  assert.equal(rows.length, 1); assert.equal(c.tabs[2].attributes['aria-pressed'], 'true');
  assert.equal(c.el('[data-notification-message]').textContent, '');
});
test('退出立即清空私人内容并重新鉴权，关闭清理请求与滚动锁', async () => {
  let n = 0; const c = await setup(async () => ++n === 1 ? response([item('submission', { reason: '私人理由' })]) : response([],401), '?notifications=submission');
  assert.equal(c.el('[data-notification-list]').children.length, 1);
  c.document.fire('nav:account-changed', { detail: { reason: 'logout' } });
  assert.equal(c.el('[data-notification-list]').children.length, 0); await tick();
  assert.equal(c.el('[data-notification-login]').hidden, false);
  c.el('[data-notification-close]').fire('click'); assert.equal(c.root.open, false);
  assert.equal(c.document.documentElement.style.overflow, '');
});
test('数据库错误与格式错误明确报错，不伪装为暂无消息', async () => {
  const c = await setup(async () => response([],503));
  assert.equal(c.el('[data-notification-message]').textContent, '请求失败');
  assert.throws(() => view.parseNotificationPage({ items: [], total: -1, page: 1, pageSize: 20 }));
  assert.throws(() => view.parseNotificationPage({ items: [item('other')], total: 1, page: 1, pageSize: 20 }));
});
test('公告写入URL不带查询参数，正文安全渲染，匿名用户菜单不读种子姓名', () => {
  assert.match(read('../src/scripts/admin-announcements.ts'), /method === 'GET' \? .* : '\/api\/admin\/announcements'/);
  assert.doesNotMatch(read('../src/scripts/admin-announcements.ts'), /innerHTML/);
  assert.match(read('../src/scripts/account-status.ts'), /renderAccountMenu\(data.user\?\.username/);
  assert.match(read('../src/components/layout/Topbar.astro'), /data-account-menu-login/);
  assert.doesNotMatch(read('../src/pages/search/index.astro'), /热门搜索|HOT_SEARCHES/);
});
