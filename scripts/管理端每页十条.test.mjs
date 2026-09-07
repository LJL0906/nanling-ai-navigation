import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as fields from '../src/lib/curated-menu-fields.ts';
import * as view from '../src/lib/notification-view.ts';
import { adminPageNumbers } from '../src/scripts/admin-pagination.ts';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('五个列表仅保留10选项，默认值与本地切片固定10且页数不封顶', () => {
  for (const name of ['sites', 'categories', 'menus', 'reviews', 'announcements']) {
    const page = read(`src/pages/admin/${name}.astro`);
    const selector = page.match(/<select[^>]*(?:page-size|review-size|announcement-size)[^>]*>(.*?)<\/select>/s);
    assert.ok(selector, name);
    assert.equal(selector[1], '<option value="10">10</option>');
  }
  for (const name of ['admin', 'admin-menus', 'admin-announcements']) {
    const source = read(`src/scripts/${name}.ts`);
    assert.match(source, /pageSize = 10/);
    assert.doesNotMatch(source, /pageSize = (?:20|50|100|Number|size)/);
  }
  const content = read('src/scripts/admin.ts');
  assert.match(content, /filtered.slice\(\(page - 1\) \* pageSize, page \* pageSize\)/);
  assert.match(content, /Math.ceil\(filtered.length \/ pageSize\)/);
  assert.match(content, /page = Math.min\(page, pages\)/);
  assert.match(content, /applied = \{ query: '', category: '', verification: '' \}; page = 1; render\(\)/);
  assert.match(read('src/scripts/admin-pagination.ts'), /pageSize: 10/);
  assert.ok(adminPageNumbers(11, 11).includes(11));
});

// 独立DOM桩，沿用现有测试环境；不修改旧规格测试。
{

const source = readFileSync(new URL('../src/scripts/admin-menus.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const menu = (id, extra = {}) => ({ id, label: id, location: 'topbar', kind: 'link', href: '/', icon: null, parentId: null, sortOrder: 0, enabled: true, payload: {}, ...extra });
const seed = [menu('group', { kind: 'group', href: null }), menu('child', { parentId: 'group' }), menu('other')];
const reply = (menus = seed, status = 200, writable = true) => ({ status, ok: status < 400, json: async () => ({ data: { menus, revision: 'v1', writable } }) });
class Element {
  listeners = new Map(); children = []; dataset = {}; value = ''; checked = false; disabled = false; hidden = false; textContent = '';
  addEventListener(type, fn, options = {}) { const entries = this.listeners.get(type) ?? []; entries.push({ fn, signal: options.signal }); this.listeners.set(type, entries); }
  fire(type, extra = {}) {
    const event = { target: this, preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const { fn, signal } of this.listeners.get(type) ?? []) if (!signal?.aborted) fn(event);
    return event;
  }
  open = false; valid = true;
  showModal() { this.open = true; } close() { this.open = false; }
  querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  setAttribute() {} focus() {} reset() {} reportValidity() { return this.valid; }
  replaceChildren(...nodes) { this.children = nodes; }
  append(node) { this.children.push(node); } add(node) { this.children.push(node); }
  get options() { return this.children; } get childElementCount() { return this.children.length; }
  closest() { return this; }
}
async function setup(handler = () => reply()) {
  const elements = new Map();
  const el = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const root = new Element(); root.querySelector = selector => el(selector.slice(6));
  const document = new Element(); document.querySelector = () => root; document.createElement = () => new Element();
  const window = new Element(); const navigations = [];
  window.location = { assign: path => navigations.push(path), replace: path => navigations.push(path) };
  const calls = [], confirmations = []; let answer = true;
  let changePage; const pager = { state: null, destroyed: false };
  const dependencies = {
    '../lib/curated-menu-fields': fields,
    './admin-pagination': { bindAdminPagination: (root, onChange) => {
      assert.equal(root, el('pagination')); changePage = onChange;
      return { update: state => { pager.state = { ...state }; }, destroy: () => { pager.destroyed = true; } };
    } },
  };
  vm.runInNewContext(code, { document, window, AbortController, TextEncoder, URL, console, Error,
    exports: {}, require: id => { assert.ok(Object.hasOwn(dependencies, id), `未知依赖 ${id}`); return dependencies[id]; }, crypto: { randomUUID: () => 'new-id' }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    confirm: message => { confirmations.push(message); return answer; },
    fetch: async (url, options) => { calls.push({ url, ...options }); return handler(calls.at(-1), calls.length); },
  });
  await tick();
  return { el, window, calls, confirmations, navigations, pager, jump: page => changePage(page), answer: value => { answer = value; },
    edit: (id, value) => { el(id).value = value; el(id).fire('input'); el('editor').fire('input'); },
    select: (id, action = 'edit') => { const target = new Element(); target.dataset.id = id; target.dataset.action = action; el('list').fire('click', { target }); },
  };
}


test('菜单105条分11页，查询重置和旧条数输入仍为10', async () => {
  const rows = Array.from({ length: 105 }, (_, i) => menu(`row-${i}`, { label: `菜单${i}`, sortOrder: i }));
  const c = await setup(() => reply(rows));
  assert.equal(c.el('list').children.length, 10);
  assert.equal(c.pager.state.totalPages, 11);
  c.jump(11); assert.equal(c.el('list').children.length, 5); assert.equal(c.el('next').disabled, true);
  for (const value of ['20', '50', '100']) {
    c.el('page-size').value = value; c.el('page-size').fire('change');
    assert.equal(c.pager.state.pageSize, 10); assert.equal(c.pager.state.page, 1);
    assert.equal(c.el('list').children.length, 10);
  }
  c.jump(2); c.el('name').value = '菜单104'; c.el('query').fire('submit');
  assert.equal(c.pager.state.page, 1); assert.equal(c.pager.state.total, 1);
  c.el('query-reset').fire('click'); assert.equal(c.pager.state.page, 1); assert.equal(c.pager.state.total, 105);
  assert.equal(c.calls.length, 1);
});
test('菜单删除末页唯一项回退上一页', async () => {
  const c = await setup(() => reply(Array.from({ length: 11 }, (_, i) => menu(`row-${i}`, { sortOrder: i }))));
  c.jump(2); c.select('row-10', 'delete');
  assert.equal(c.pager.state.page, 1); assert.equal(c.pager.state.total, 10);
  assert.equal(c.el('list').children.length, 10);
});
}

// 独立DOM桩，沿用现有测试环境；不修改旧规格测试。
{

const page = readFileSync(new URL('../src/pages/admin/reviews.astro', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/scripts/admin-reviews.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
const record = { id: '12345678-1234-4123-8123-123456789abc', name: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', categoryId: 'ai', customCategory: '自定义', iconUrl: '<svg onload=alert(1)>', remark: '私有内容\n第二行', createdAt: '2026-09-07T00:00:00Z', status: 'pending', reviewReason: '', reviewedBy: null, reviewedAt: null, publishedSiteId: null };
const reply = (data, status = 200) => ({ status, ok: status < 400, json: async () => status < 400 ? { data } : { error: { message: data } } });
class Element {
  listeners = new Map(); children = []; dataset = {}; attributes = {}; value = ''; disabled = false; hidden = false; textContent = ''; isConnected = true; open = false;
  constructor(tag = '') { this.tagName = tag; }
  addEventListener(type, fn, options = {}) { const entries = this.listeners.get(type) ?? []; entries.push({ fn, signal: options.signal }); this.listeners.set(type, entries); }
  fire(type, extra = {}) {
    const event = { preventDefault() { this.defaultPrevented = true; }, ...extra };
    for (const { fn, signal } of this.listeners.get(type) ?? []) if (!signal?.aborted) fn(event);
    return event;
  }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children.forEach(n => { n.isConnected = false; }); this.children = nodes; }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(selector.split(', ').includes(n.tagName) ? [n] : []), ...n.querySelectorAll(selector)]); }
  focus() { this.owner.activeElement = this; }
  setCustomValidity(value) { this.validationMessage = value; }
  reportValidity() { return !this.validationMessage; }
  showModal() { this.open = true; }
  close() { if (this.open) { this.open = false; this.fire('close'); } }
}
async function setup({ items = [record], patch = () => reply({}), listReply } = {}) {
  const document = new Element(), window = new Element(), root = new Element();
  const elements = new Map();
  for (const [, id] of page.matchAll(/id="(review-[^"]+)"/g)) { const e = new Element(); e.owner = document; elements.set(id.slice(7), e); }
  const el = id => elements.get(id);
  const pagerRoot = new Element(); const pagerStates = []; let changePage; let destroyed = false;
  el('status').tagName = el('size').tagName = 'select'; el('status').value = 'pending'; el('size').value = '20';
  el('reason').tagName = 'textarea';
  for (const id of ['prev', 'next', 'logout', 'reset']) el(id).tagName = 'button';
  const close = new Element('button'); close.owner = document;
  root.children = [...elements.values(), close];
  root.querySelector = selector => selector === '.admin-pagination' ? pagerRoot : el(selector.slice(8));
  const all = root.querySelectorAll.bind(root);
  root.querySelectorAll = selector => selector === '[data-review-close]' ? [close] : all(selector);
  document.querySelector = () => root;
  document.createElement = tag => { const e = new Element(tag); e.owner = document; return e; };
  el('form').reset = () => { el('reason').value = ''; };
  const confirmations = [], calls = [], navigations = []; let answer = false;
  window.confirm = text => { confirmations.push(text); return answer; };
  window.location = { assign: url => navigations.push(url) };
  vm.runInNewContext(code, { document, window, AbortController, URLSearchParams, Intl, Error, exports: {}, require: id => {
    assert.equal(id, './admin-pagination');
    return { bindAdminPagination: (target, onChange) => { assert.equal(target, pagerRoot); changePage = onChange; return { update: state => pagerStates.push(state), destroy: () => { destroyed = true; } }; } };
  }, fetch: async (url, options) => {
    calls.push({ url, ...options });
    if (options.method === 'PATCH') return patch(calls.at(-1));
    if (url === '/api/admin/session') return reply({ username: 'admin' });
    const params = new URL(url, 'http://localhost').searchParams;
    return listReply ? listReply(params) : reply({ items, total: 60, page: Number(params.get('page')), totalPages: 3 });
  } });
  await tick();
  const actions = () => el('list').children[0].children.at(-1).children[0].children;
  return { el, close, document, window, calls, confirmations, navigations, pagerStates, changePage: p => changePage(p), destroyed: () => destroyed, answer: value => { answer = value; }, actions,
    open: (review = true) => actions().find(b => b.textContent === (review ? '审核' : '详情')).fire('click'),
    submit: (value = 'approved') => el('form').fire('submit', { submitter: { value } }) };
}


test('审核请求始终10，保留查询、重置和超过10页跳转', async () => {
  const c = await setup({ listReply: params => reply({ items: [record], total: 105, totalPages: 11, page: Number(params.get('page')) }) });
  assert.match(c.calls.at(-1).url, /pageSize=10/);
  c.el('size').value = '50'; c.el('query').value = '测试'; c.el('filters').fire('submit'); await tick();
  c.changePage(11); await tick();
  assert.equal(c.pagerStates.at(-1).page, 11);
  assert.equal(c.el('list').children[0].children[0].textContent, '101');
  assert.equal(new URL(c.calls.at(-1).url, 'http://localhost').searchParams.get('q'), '测试');
  c.el('filters').fire('reset'); await tick();
  assert.match(c.calls.at(-1).url, /status=pending&q=&page=1&pageSize=10/);
  c.el('size').value = '100'; c.el('size').fire('change'); await tick();
  assert.match(c.calls.at(-1).url, /page=1&pageSize=10/);
});
test('审核结果减少时按实际末页回退并以10重取', async () => {
  const c = await setup({ listReply: params => reply({ items: [record], total: 10, totalPages: 1, page: Number(params.get('page')) }) });
  c.changePage(2); await tick();
  assert.equal(c.pagerStates.at(-1).page, 1);
  assert.match(c.calls.at(-2).url, /page=2&pageSize=10/);
  assert.match(c.calls.at(-1).url, /page=1&pageSize=10/);
});
}

// 独立DOM桩，沿用现有测试环境；不修改旧规格测试。
{
const source = readFileSync(new URL('../src/scripts/admin-announcements.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const paginationCode = ts.transpileModule(readFileSync(new URL('../src/scripts/admin-pagination.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const pageSource = readFileSync(new URL('../src/pages/admin/announcements.astro', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Element {
  children = []; listeners = new Map(); dataset = {}; value = ''; hidden = false; disabled = false; textContent = '';
  open = false; classList = { add() {} };
  querySelector() { return null; }
  showModal() { this.open = true; } close() { this.open = false; }
  setCustomValidity() {} remove() {} insertBefore(node) { this.children.push(node); }
  addEventListener(type, callback, options = {}) { const wrapped = event => { if (!options.signal?.aborted) callback(event); }; const callbacks = this.listeners.get(type) ?? []; callbacks.push(wrapped); this.listeners.set(type, callbacks); }
  fire(type, extra = {}) { const event = { target: this, preventDefault() { this.prevented = true; }, ...extra }; for (const fn of this.listeners.get(type) ?? []) fn(event); return event; }
  append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; }
  setAttribute() {} reportValidity() { return true; } scrollIntoView() {} focus() {}
  querySelectorAll() { return this.children.flatMap(node => [node, ...node.querySelectorAll()]); }
  closest() { return this; }
}
const fixture = { id: '11111111-1111-4111-8111-111111111111', kind: 'announcement', title: '测试公告', body: '正文', createdAt: '2026-09-07T00:00:00Z', revision: 'a'.repeat(64) };
const response = (data, status = 200) => ({ status, ok: status < 400, json: async () => ({ data, error: { message: '失败' } }) });
const listResponse = (items = [fixture]) => response({ items, total: items.length, page: 1, pageSize: 20 });
async function setup(handler = async call => call.method === 'GET' ? listResponse() : response({ id: fixture.id })) {
  const nodes = new Map(); const el = selector => { if (!nodes.has(selector)) nodes.set(selector, new Element()); return nodes.get(selector); };
  const root = new Element(); root.querySelector = el;
  const form = el('[data-announcement-form]'); form.elements = { namedItem: name => el(name) }; form.querySelector = el;
  form.reset = () => { el('title').value = ''; el('body').value = ''; };
  const document = new Element(); document.querySelector = () => root; document.createElement = tag => Object.assign(new Element(), { tagName: tag });
  document.createTextNode = textContent => Object.assign(new Element(), { textContent });
  const window = new Element(); const calls = []; let uuidCalls = 0;
  const pagination = {}; vm.runInNewContext(paginationCode, { exports: pagination, document, Element, AbortController });
  el('[data-announcement-login]').hidden = true;
  vm.runInNewContext(code, { exports: {}, require: path => path.includes('admin-pagination') ? pagination : view, document, window, Element, Error, AbortController, AbortSignal,
    crypto: { randomUUID: () => `${String(++uuidCalls).padStart(8, '0')}-1111-4111-8111-111111111111` }, confirm: () => true,
    fetch: async (url, options) => { const call = { url, ...options }; calls.push(call); return handler(call); },
  });
  await tick(); return { el, form, window, calls, uuidCalls: () => uuidCalls, add: () => el('[data-announcement-add]').fire('click'), action: action => {
    const button = el('[data-announcement-list]').querySelectorAll().find(node => node.dataset.action === action);
    assert.ok(button, `表格缺少${action}按钮`); el('[data-announcement-list]').fire('click', { target: button });
  } };
}

test('公告请求固定10，删除末页唯一项回退且旧选项不改变条数', async () => {
  let total = 11;
  const c = await setup(async call => {
    if (call.method === 'DELETE') { total = 10; return response({}); }
    const page = Number(new URL(call.url, 'http://localhost').searchParams.get('page'));
    return response({ items: page === 2 && total === 10 ? [] : [fixture], total, page, pageSize: 10 });
  });
  assert.match(c.calls.at(-1).url, /page=1&pageSize=10/);
  c.el('[data-announcement-next]').fire('click'); await tick();
  assert.match(c.calls.at(-1).url, /page=2&pageSize=10/);
  c.action('delete'); await tick(); await tick();
  assert.match(c.calls.at(-1).url, /page=1&pageSize=10/);
  assert.equal(c.el('[data-announcement-next]').disabled, true);
  c.el('[data-announcement-size]').value = '100'; c.el('[data-announcement-size]').fire('change'); await tick();
  assert.match(c.calls.at(-1).url, /page=1&pageSize=10/);
});
}
