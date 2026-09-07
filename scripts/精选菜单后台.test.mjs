import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as fields from '../src/lib/curated-menu-fields.ts';
import { curatedGroupsFromMenus } from '../src/lib/curated-menu-directory.ts';
import { validateMenus, visibleMenus } from '../src/server/menu-validation.ts';

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
  open = false;
  showModal() { this.open = true; } close() { this.open = false; }
  querySelectorAll() { return this.children.flatMap(child => [child, ...child.querySelectorAll()]); }
  setAttribute() {} focus() {} reset() {} reportValidity() { return true; }
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
  const dependencies = {
    '../lib/curated-menu-fields': fields,
    './admin-pagination': { bindAdminPagination: (paginationRoot, onChange) => {
      assert.equal(paginationRoot, el('pagination')); assert.equal(typeof onChange, 'function');
      return { update() {}, destroy() {} };
    } },
  };
  vm.runInNewContext(code, { document, window, AbortController, TextEncoder, URL, console, Error,
    exports: {}, require: id => { assert.ok(Object.hasOwn(dependencies, id), `未知依赖 ${id}`); return dependencies[id]; }, crypto: { randomUUID: (() => { let id = 0; return () => `new-id-${++id}`; })() }, Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    confirm: message => { confirmations.push(message); return answer; },
    fetch: async (url, options) => { calls.push({ url, ...options }); return handler(calls.at(-1), calls.length); },
  });
  await tick();
  return { el, window, calls, confirmations, navigations, answer: value => { answer = value; },
    edit: (id, value) => { el(id).value = value; el(id).fire('input'); el('editor').fire('input'); },
    select: id => { const target = new Element(); target.dataset.id = id; target.dataset.action = 'edit'; el('list').fire('click', { target }); },
  };
}

const resource = menu('resource', { kind: 'resource', parentId: 'group', href: 'https://example.com', payload: { description: '旧描述', sourceTitle: '旧来源', sourceUrl: 'https://example.com/docs', checkedAt: '2024-02-29', extra: '保留' } });
const initial = [seed[0], resource, seed[2]];
async function writableSetup() {
  let stored = structuredClone(initial);
  const c = await setup(call => {
    if (call.method === 'PUT') stored = validateMenus(JSON.parse(call.body).menus);
    return reply(structuredClone(stored));
  });
  return { ...c, stored: () => stored };
}
test('真实后台脚本：编辑五字段保存后回填，并投影到 discover', async () => {
  const c = await writableSetup(); c.select('resource'); assert.equal(c.el('dialog').open, true);
  const changes = { description: '新的描述', useCase: '适合开发', sourceUrl: 'https://example.com/new', sourceTitle: '新文档', checkedAt: '2026-09-07' };
  for (const [key, value] of Object.entries(changes)) c.edit(key, value);
  c.el('save').fire('click'); await tick();
  assert.equal(c.calls.length, 2);
  const saved = c.stored().find(m => m.id === 'resource');
  assert.deepEqual(saved.payload, { ...changes, extra: '保留' });
  const projected = curatedGroupsFromMenus(visibleMenus(c.stored()))[0].resources[0];
  for (const [key, value] of Object.entries(changes)) { assert.equal(projected[key], value); assert.equal(c.el(key).value, value); }
});
test('真实后台脚本：高级 JSON 与字段混编、清空删除、应用后再次编辑不覆盖 JSON', async () => {
  const c = await writableSetup(); c.select('resource'); assert.equal(c.el('dialog').open, true);
  c.edit('payload', JSON.stringify({ sourceTitle: 'JSON标题', extra: '保留', description: 'JSON描述' }));
  c.edit('description', '表单描述'); c.edit('sourceTitle', '');
  c.el('editor').fire('submit'); assert.equal(c.el('dialog').open, false);
  c.select('resource');
  assert.equal(c.el('description').value, '表单描述'); assert.equal(c.el('sourceTitle').value, '');
  c.edit('payload', JSON.stringify({ description: '第二次JSON描述', extra: '保留' }));
  c.el('save').fire('click'); await tick();
  assert.deepEqual(c.stored().find(m => m.id === 'resource').payload, { description: '第二次JSON描述', extra: '保留' });
});
test('真实后台脚本：新增分组与资源，启用保存、隐藏、级联删除同步目录', async () => {
  const c = await writableSetup();
  c.el('add-group').fire('click'); const groupId = c.el('id').value;
  c.edit('label', '新组'); c.el('enabled').checked = true; c.edit('description', '新组介绍');
  c.el('editor').fire('submit'); assert.equal(c.el('dialog').open, false);
  c.el('add-resource').fire('click'); const resourceId = c.el('id').value;
  assert.equal(c.el('parent').value, groupId);
  c.edit('label', '新资源'); c.edit('href', '/local/'); c.el('enabled').checked = true;
  c.el('save').fire('click'); await tick();
  let groups = curatedGroupsFromMenus(visibleMenus(c.stored()));
  assert.equal(groups.find(g => g.label === '新组').resources[0].id, resourceId);
  c.select(groupId); c.el('enabled').checked = false; c.el('editor').fire('change');
  c.el('save').fire('click'); await tick();
  assert.equal(curatedGroupsFromMenus(visibleMenus(c.stored())).length, 1);
  c.el('delete').fire('click'); c.el('save').fire('click'); await tick();
  assert.equal(c.stored().some(m => m.id === groupId || m.id === resourceId), false);
});
test('真实后台脚本：无分组不新增资源；无效来源/日期在发送前拒绝并保留草稿', async () => {
  const empty = await setup(() => reply([seed[2]])); empty.el('add-resource').fire('click');
  assert.match(empty.el('status').textContent, /请先新增/); assert.equal(empty.calls.length, 1);
  for (const [key, value] of [['sourceUrl', 'javascript:alert(1)'], ['checkedAt', '2025-02-29']]) {
    const c = await writableSetup(); c.select('resource'); assert.equal(c.el('dialog').open, true); c.edit(key, value);
    c.el('save').fire('click'); await tick();
    assert.equal(c.calls.length, 1); assert.equal(c.el(key).value, value);
    assert.equal(c.window.fire('beforeunload').defaultPrevented, true);
  }
});
test('真实后台脚本：只读、加载失败不会开放精选新增操作', async () => {
  for (const handler of [() => reply(initial, 200, false), () => { throw new Error('离线'); }]) {
    const c = await setup(handler);
    assert.equal(c.el('add-group').disabled, true); assert.equal(c.el('add-resource').disabled, true);
    c.el('add-group').fire('click'); c.el('add-resource').fire('click');
    assert.equal(c.calls.length, 1);
  }
});
test('真实后台脚本：409 拒绝重提，500 重试保留精选草稿', async () => {
  for (const status of [409, 500]) {
    const c = await setup((call, count) => count === 2 ? reply(initial, status) : call.method === 'PUT' ? reply(JSON.parse(call.body).menus) : reply(initial));
    c.select('resource'); c.edit('sourceTitle', '待保存'); c.el('save').fire('click'); await tick();
    assert.equal(c.el('sourceTitle').value, '待保存');
    if (status === 409) { assert.equal(c.el('add-group').disabled, true); c.el('save').fire('click'); assert.equal(c.calls.length, 2); }
    else { c.el('retry').fire('click'); await tick(); assert.equal(c.calls[2].method, 'PUT'); assert.equal(JSON.parse(c.calls[2].body).menus.find(m => m.id === 'resource').payload.sourceTitle, '待保存'); }
  }
});
