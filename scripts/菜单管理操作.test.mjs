import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as fields from '../src/lib/curated-menu-fields.ts';

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

test('现有编辑、排序、显隐与新增整份保存保持可用；保存后不重复提交', async () => {
  const c = await setup(call => call.method === 'PUT' ? reply(JSON.parse(call.body).menus) : reply());
  c.select('other'); c.edit('label', '修改名称'); c.edit('order', '12'); c.el('enabled').checked = false;
  c.el('save').fire('click'); await tick();
  const saved = JSON.parse(c.calls[1].body).menus.find(m => m.id === 'other');
  assert.equal(saved.label, '修改名称'); assert.equal(saved.sortOrder, 12); assert.equal(saved.enabled, false);
  assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
  c.el('save').fire('click'); assert.equal(c.calls.length, 2);
  c.el('add').fire('click'); c.el('save').fire('click'); await tick();
  const added = JSON.parse(c.calls[2].body).menus.find(m => m.id === 'menu:new-id');
  assert.equal(added.enabled, false); assert.equal(added.href, '/');
});

test('删除父组明确包含子项；取消不改草稿，确认仅删除父组及其子项', async () => {
  const c = await setup(call => call.method === 'PUT' ? reply(JSON.parse(call.body).menus) : reply());
  c.answer(false); c.el('delete').fire('click');
  assert.match(c.confirmations.at(-1), /group.*及其 1 个子菜单/);
  assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
  c.answer(true); c.el('delete').fire('click'); c.el('save').fire('click'); await tick();
  assert.deepEqual(JSON.parse(c.calls[1].body).menus.map(m => m.id), ['other']);
});

test('未应用表单、已应用草稿均提醒离开；撤销表单恢复干净状态', async () => {
  const c = await setup(); c.edit('label', '草稿');
  let event = c.window.fire('beforeunload'); assert.equal(event.defaultPrevented, true); assert.equal(event.returnValue, '');
  c.el('revert').fire('click'); assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
  c.edit('label', '草稿'); c.el('editor').fire('submit');
  assert.equal(c.window.fire('beforeunload').defaultPrevented, true);
  c.answer(false); c.el('reload').fire('click'); assert.equal(c.calls.length, 1);
});

test('加载网络失败可重试；只读模式不开放写操作', async () => {
  const c = await setup((call, count) => { if (count === 1) throw new Error('offline'); return reply(seed, 200, false); });
  assert.match(c.el('status').textContent, /加载失败.*offline/); assert.equal(c.el('retry').hidden, false);
  c.el('retry').fire('click'); await tick(); assert.equal(c.el('workspace').hidden, false);
  assert.equal(c.el('save').disabled, true); c.el('add').fire('click'); c.el('save').fire('click'); assert.equal(c.calls.length, 2);
});

test('保存失败保留草稿，重试仍为 PUT；保存期间阻止重复保存、加载和退出', async () => {
  const gate = deferred();
  const c = await setup((call, count) => count === 2 ? gate.promise : count === 3 ? reply(JSON.parse(call.body).menus) : reply());
  c.edit('label', '保留'); c.el('save').fire('click');
  for (const id of ['save', 'reload', 'logout']) c.el(id).fire('click');
  assert.equal(c.calls.length, 2); assert.equal(c.el('logout').disabled, true);
  gate.resolve({ status: 502, ok: false, json: async () => { throw new Error('HTML'); } }); await tick();
  assert.match(c.el('status').textContent, /草稿仍保留.*HTTP 502/); assert.equal(c.el('retry').textContent, '重试保存');
  assert.equal(c.window.fire('beforeunload').defaultPrevented, true);
  c.el('retry').fire('click'); await tick(); assert.equal(c.calls[2].method, 'PUT');
  assert.equal(JSON.parse(c.calls[2].body).menus[0].label, '保留');
});

test('409 禁止旧草稿重提，重试加载仍需丢弃确认', async () => {
  const c = await setup((call, count) => count === 2 ? reply(seed, 409) : reply());
  c.edit('label', '冲突草稿'); c.el('save').fire('click'); await tick();
  assert.equal(c.el('conflict').hidden, false); assert.equal(c.el('save').disabled, true);
  c.el('save').fire('click'); assert.equal(c.calls.length, 2);
  c.answer(false); c.el('retry').fire('click'); assert.equal(c.calls.length, 2);
  c.answer(true); c.el('retry').fire('click'); await tick(); assert.equal(c.calls[2].method, 'GET');
});

test('401 不自动跳走丢弃草稿，重新登录后可重试保存', async () => {
  const c = await setup((call, count) => count === 2 ? reply(seed, 401) : call.method === 'PUT' ? reply(JSON.parse(call.body).menus) : reply());
  c.edit('label', '待登录'); c.el('save').fire('click'); await tick();
  assert.deepEqual(c.navigations, []); assert.match(c.el('status').textContent, /新标签页登录后重试/);
  assert.equal(c.window.fire('beforeunload').defaultPrevented, true);
  c.el('retry').fire('click'); await tick(); assert.equal(c.calls[2].method, 'PUT');
});

test('退出防重且与保存互斥，失败保留草稿；成功退出不再触发丢弃提醒', async () => {
  const gate = deferred(); const c = await setup((call, count) => count === 2 ? gate.promise : reply());
  c.edit('label', '退出草稿'); c.answer(false); c.el('logout').fire('click'); assert.equal(c.calls.length, 1);
  c.answer(true); c.el('logout').fire('click'); c.el('logout').fire('click'); c.el('save').fire('click');
  assert.equal(c.calls.length, 2); assert.equal(c.el('save').disabled, true);
  gate.resolve({ ok: false }); await tick(); assert.match(c.el('status').textContent, /退出失败，草稿仍保留/);
  assert.equal(c.window.fire('beforeunload').defaultPrevented, true);
  c.el('logout').fire('click'); await tick(); assert.deepEqual(c.navigations, ['/admin/login/']);
  assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
});

test('页面离开取消请求，迟到响应不更新旧页面', async () => {
  const gate = deferred(); const c = await setup(() => gate.promise);
  c.window.fire('pagehide'); assert.equal(c.calls[0].signal.aborted, true);
  gate.resolve(reply()); await tick(); assert.equal(c.el('workspace').hidden, true);
});


test('菜单页只保留操作界面和必要状态，移除大标题与帮助段落', () => {
  const page = readFileSync(new URL('../src/pages/admin/menus.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /<header>|<h1\b|<h2\b|<h3\b|<p class="hint">/);
  for (const id of ['summary', 'list-title', 'editor-title', 'filter', 'list', 'editor', 'fields', 'add', 'add-group', 'add-resource', 'dialog', 'query', 'name', 'visible', 'query-reset', 'close', 'cancel', 'delete', 'save', 'reload', 'retry', 'status', 'conflict', 'dirty', 'mode', 'payload']) {
    assert.ok(page.includes(`id="menu-${id}"`), `保留 menu-${id} 选择器`);
  }
  assert.match(page, /AdminLayout/);
});


test('标准表格只显示业务字段；查询名称、区域、实际显示状态并重置，不改变草稿', async () => {
  const c = await setup(() => reply([menu('secret-id', { label: '资料站', payload: { internal: 'secret-payload' } }),
    menu('group', { kind: 'group', href: null, enabled: false }), menu('child', { label: '子资源', parentId: 'group' })]));
  const cells = () => c.el('list').children.map(row => row.children.slice(0, 6).map(cell => cell.textContent));
  assert.equal(cells().length, 3); assert.doesNotMatch(JSON.stringify(cells()), /secret-id|secret-payload/);
  c.el('name').value = '资料'; c.el('filter').value = 'topbar'; c.el('visible').value = 'enabled';
  assert.equal(cells().length, 3); c.el('query').fire('submit');
  assert.deepEqual(cells(), [['资料站', '顶部导航', '链接', '根菜单', '0', '显示']]);
  c.el('name').value = ''; c.el('visible').value = 'parent-hidden'; c.el('query').fire('submit');
  assert.equal(cells()[0][0], '子资源'); assert.equal(cells()[0][3], 'group');
  c.el('filter').value = 'sidebar'; c.el('query').fire('submit');
  assert.equal(c.el('list').children[0].children[0].colSpan, 7);
  c.el('query-reset').fire('click'); assert.equal(cells().length, 3);
  assert.equal(c.calls.length, 1); assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
});

test('原生弹窗支持重复编辑，取消与 Escape 提示，应用关闭并保留草稿', async () => {
  const c = await setup(); assert.equal(c.el('dialog').open, false);
  c.select('other'); assert.equal(c.el('dialog').open, true); c.edit('label', '未应用');
  c.answer(false); c.el('cancel').fire('click'); assert.equal(c.el('dialog').open, true);
  assert.equal(c.el('dialog').fire('cancel').defaultPrevented, true); assert.equal(c.el('label').value, '未应用');
  c.answer(true); c.el('close').fire('click'); assert.equal(c.el('dialog').open, false);
  assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
  c.select('other'); assert.equal(c.el('label').value, 'other');
  c.edit('label', '已应用'); c.el('editor').fire('submit'); assert.equal(c.el('dialog').open, false);
  c.select('other'); assert.equal(c.el('label').value, '已应用'); c.el('cancel').fire('click');
  assert.equal(c.window.fire('beforeunload').defaultPrevented, true); assert.equal(c.calls.length, 1);
});

test('新增隐藏草稿取消不丢失，精选分组与资源沿用默认父级及原始字段合并', async () => {
  for (const action of ['add', 'add-group', 'add-resource']) {
    const c = await setup(call => call.method === 'PUT' ? reply(JSON.parse(call.body).menus) : reply());
    c.el(action).fire('click'); assert.equal(c.el('dialog').open, true);
    c.edit('label', '未应用名称'); c.el('cancel').fire('click');
    assert.equal(c.window.fire('beforeunload').defaultPrevented, true);
    c.el('save').fire('click'); await tick();
    const added = JSON.parse(c.calls[1].body).menus.find(m => m.id === 'menu:new-id');
    assert.equal(added.enabled, false); assert.notEqual(added.label, '未应用名称');
    assert.equal(added.kind, action === 'add' ? 'link' : action === 'add-group' ? 'group' : 'resource');
    assert.equal(added.parentId, action === 'add-resource' ? 'group' : null);
  }
  const original = [seed[0], menu('old:resource', { kind: 'resource', parentId: 'group', payload: { description: '旧描述', target: '_blank', custom: { keep: true } } })];
  const c = await setup(call => call.method === 'PUT' ? reply(JSON.parse(call.body).menus) : reply(original));
  c.select('old:resource'); c.edit('description', '新描述'); c.el('editor').fire('submit');
  c.el('save').fire('click'); await tick();
  const saved = JSON.parse(c.calls[1].body).menus[1];
  assert.equal(saved.id, 'old:resource'); assert.deepEqual(saved.payload, { description: '新描述', target: '_blank', custom: { keep: true } });
});

test('表格删除独立于选中项；busy 时禁止弹窗关闭、新增、编辑和删除', async () => {
  const gate = deferred(); const c = await setup((call, count) => count === 2 ? gate.promise : reply());
  c.select('other', 'delete'); c.select('child'); c.edit('label', '保存中'); c.el('save').fire('click');
  const confirmations = c.confirmations.length;
  c.el('cancel').fire('click'); c.el('dialog').fire('cancel'); c.el('close').fire('click');
  c.el('add').fire('click'); c.select('group'); c.select('group', 'delete');
  assert.equal(c.el('dialog').open, true); assert.equal(c.el('id').value, 'child');
  assert.equal(c.confirmations.length, confirmations); assert.equal(c.calls.length, 2);
  assert.deepEqual(JSON.parse(c.calls[1].body).menus.map(m => m.id), ['group', 'child']);
  gate.resolve(reply(JSON.parse(c.calls[1].body).menus)); await tick(); assert.equal(c.el('dialog').open, false);
});

test('表单错误在弹窗内提示且不关闭、不丢弃；原生校验失败不应用', async () => {
  const c = await setup(); c.select('other'); c.edit('payload', 'invalid JSON'); c.el('editor').fire('submit');
  assert.equal(c.el('dialog').open, true); assert.ok(c.el('form-status').textContent);
  assert.equal(c.el('payload').value, 'invalid JSON'); assert.equal(c.calls.length, 1);
  c.el('editor').valid = false; c.el('editor').fire('submit'); assert.equal(c.el('dialog').open, true);
});

test('页面使用共享样式、原生弹窗与七列表头，主列表没有 ID 或 payload', () => {
  const page = readFileSync(new URL('../src/pages/admin/menus.astro', import.meta.url), 'utf8');
  assert.match(page, /admin-content\.css/); assert.match(page, /<dialog id="menu-dialog" class="content-dialog"/);
  const table = page.slice(page.indexOf('<table'), page.indexOf('</table>'));
  assert.deepEqual([...table.matchAll(/<th scope="col">(.*?)<\/th>/g)].map(m => m[1]), ['名称', '区域', '类型', '父菜单', '排序', '显示状态', '操作']);
  assert.doesNotMatch(table, /payload|菜单 ID/); assert.doesNotMatch(page, /workspace-grid|class="menu-list"/);
  assert.ok(source.split('\n').length < 500); assert.ok(page.split('\n').length < 500);
});


test('本地分页固定10条且拒绝旧条数、边界按钮、数字跳转，筛选与重置回第一页且不发请求', async () => {
  const rows = Array.from({ length: 105 }, (_, i) => menu(`row-${i}`, { label: `菜单${i}`, sortOrder: i }));
  const c = await setup(() => reply(rows));
  assert.equal(c.el('list').children.length, 10); assert.equal(c.el('prev').disabled, true);
  assert.equal(c.pager.state.total, 105); assert.equal(c.pager.state.totalPages, 11);
  c.el('next').fire('click'); assert.equal(c.pager.state.page, 2);
  c.jump(11); assert.equal(c.el('list').children.length, 5); assert.equal(c.el('next').disabled, true);
  c.el('prev').fire('click'); assert.equal(c.pager.state.page, 10);
  c.el('page-size').value = '50'; c.el('page-size').fire('change');
  assert.equal(c.pager.state.page, 1); assert.equal(c.pager.state.totalPages, 11); assert.equal(c.el('list').children.length, 10);
  c.jump(3); c.el('page-size').value = '100'; c.el('page-size').fire('change');
  assert.equal(c.pager.state.page, 1); assert.equal(c.el('list').children.length, 10);
  c.jump(2); c.el('name').value = '菜单104'; c.el('query').fire('submit');
  assert.equal(c.pager.state.page, 1); assert.equal(c.pager.state.total, 1); assert.equal(c.pager.state.totalPages, 1);
  c.el('query-reset').fire('click'); assert.equal(c.pager.state.page, 1); assert.equal(c.pager.state.total, 105);
  assert.match(c.el('page-summary').textContent, /105.*1 \/ 11/);
  assert.equal(c.calls.length, 1); assert.equal(c.window.fire('beforeunload').defaultPrevented, undefined);
  c.window.fire('pagehide'); assert.equal(c.pager.destroyed, true);
});

test('分页只切换视图不丢草稿；删除末页自动回退；请求期间分页回调不可修改页面', async () => {
  const rows = Array.from({ length: 21 }, (_, i) => menu(`row-${i}`, { sortOrder: i }));
  const gate = deferred(); const c = await setup((call, count) => count === 2 ? gate.promise : reply(rows));
  c.select('row-0'); c.edit('label', '跨页草稿'); c.el('editor').fire('submit');
  c.jump(3); assert.equal(c.el('list').children.length, 1); c.select('row-20', 'delete'); assert.equal(c.pager.state.page, 2); assert.equal(c.pager.state.total, 20);
  c.el('save').fire('click'); assert.equal(c.pager.state.busy, true);
  c.jump(1); c.el('prev').fire('click'); c.el('next').fire('click'); c.el('page-size').value = '50'; c.el('page-size').fire('change');
  assert.equal(c.pager.state.page, 2); assert.equal(c.pager.state.pageSize, 10);
  const saved = JSON.parse(c.calls[1].body).menus; assert.equal(saved[0].label, '跨页草稿'); assert.equal(saved.length, 20);
  gate.resolve(reply(saved)); await tick(); assert.equal(c.pager.state.busy, false);
});


test('弹窗采用统一头部、正文、页脚，外置提交绑定原表单并保留字段集 busy 保护', () => {
  const page = readFileSync(new URL('../src/pages/admin/menus.astro', import.meta.url), 'utf8');
  assert.match(page, /<header class="content-dialog-header">/);
  assert.match(page, /id="menu-close" class="content-dialog-close"/);
  assert.match(page, /<div class="content-dialog-body">[\s\S]*?<form id="menu-editor"/);
  assert.match(page, /<\/form>\s*<\/div>\s*<footer class="content-dialog-footer">/);
  assert.match(page, /<button type="submit" form="menu-editor"/);
  assert.match(page, /<fieldset id="menu-fields">[\s\S]*?<footer class="content-dialog-footer">[\s\S]*?<\/footer>\s*<\/fieldset>/);
  const css = page.slice(page.indexOf('<style'));
  assert.doesNotMatch(css, /admin-filter|admin-table|editor-actions|\.menu-admin button \{/);
});
