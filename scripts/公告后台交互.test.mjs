import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as view from '../src/lib/notification-view.ts';
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
const listResponse = (items = [fixture]) => response({ items, total: items.length, page: 1, pageSize: 10 });
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
test('发布草稿固定UUID；网络失败保留内容，重试复用ID和无query写入URL', async () => {
  let post = 0;
  const c = await setup(async call => {
    if (call.method === 'GET') return listResponse([]);
    if (++post === 1) throw new Error('响应丢失');
    return response({ id: fixture.id });
  });
  c.add(); c.el('title').value = '标题'; c.el('body').value = '正文'; c.form.fire('submit'); await tick();
  assert.equal(c.el('title').value, '标题'); assert.equal(c.el('[data-announcement-save]').disabled, false);
  c.form.fire('submit'); await tick();
  const posts = c.calls.filter(call => call.method === 'POST'); assert.equal(posts.length, 2);
  assert.equal(posts[0].url, '/api/admin/announcements'); assert.equal(posts[0].body, posts[1].body);
  assert.match(JSON.parse(posts[0].body).id, /^[0-9a-f-]{36}$/); assert.equal(c.uuidCalls(), 1); assert.equal(c.el('title').value, '');
});
test('编辑和删除携带加载时revision，不丢失冲突草稿', async () => {
  const c = await setup(async call => call.method === 'GET' ? listResponse() : response(null,409));
  c.action('edit'); c.el('body').value = '新正文';
  c.form.fire('submit'); await tick();
  const put = c.calls.find(call => call.method === 'PUT'); assert.equal(JSON.parse(put.body).revision, fixture.revision);
  assert.equal(c.el('body').value, '新正文');
  assert.equal(c.el('[data-announcement-dialog]').open, true);
  assert.match(c.el('[data-announcement-form-message]').textContent, /草稿已保留/);
  c.el('[data-announcement-cancel]').fire('click'); c.action('delete'); await tick();
  assert.equal(JSON.parse(c.calls.find(call => call.method === 'DELETE').body).revision, fixture.revision);
});
test('401不导航丢弃草稿，显示另开登录入口', async () => {
  const c = await setup(async call => call.method === 'GET' ? listResponse([]) : response(null,401));
  c.add(); c.el('title').value = '未保存'; c.el('body').value = '正文'; c.form.fire('submit'); await tick();
  assert.equal(c.el('title').value, '未保存'); assert.equal(c.el('[data-announcement-login]').hidden, false);
  assert.match(c.el('[data-announcement-form-message]').textContent, /草稿已保留/);
});
test('BFCache恢复重建请求控制器，保留草稿并解除禁用', async () => {
  const c = await setup(); c.add(); c.el('title').value = '草稿';
  c.window.fire('pagehide'); c.window.fire('pageshow', { persisted: true }); await tick();
  assert.equal(c.calls.length, 2); assert.equal(c.calls[0].signal.aborted, true); assert.equal(c.calls[1].signal.aborted, false);
  assert.equal(c.el('title').value, '草稿'); assert.equal(c.el('[data-announcement-save]').disabled, false);
});
test('有草稿离开触发保护，公告输出只用textContent', async () => {
  const c = await setup(); assert.equal(c.window.fire('beforeunload').prevented, undefined);
  c.add(); c.el('title').value = '草稿'; assert.equal(c.window.fire('beforeunload').prevented, true);
  assert.doesNotMatch(source, /innerHTML/);
});

test('保留表格、原生详情dialog、统一分页及每页条数', async () => {
  const c = await setup();
  assert.match(pageSource, /<table\b/); assert.match(pageSource, /<dialog\b/);
  assert.match(pageSource, /class="admin-pagination-actions"/);
  assert.match(pageSource, /option value="10">10<\/option>/);
  for (const size of [20, 50, 100]) assert.doesNotMatch(pageSource, new RegExp(`option value="${size}"`));
  assert.equal(c.el('[data-announcement-list]').children[0].tagName, 'tr');
  c.action('detail'); assert.equal(c.el('[data-announcement-dialog]').open, true);
  assert.equal(c.el('title').readOnly, true); assert.equal(c.el('[data-announcement-save]').hidden, true);
  c.form.fire('submit'); await tick(); assert.equal(c.calls.length, 1);
  c.el('[data-announcement-close]').fire('click'); assert.equal(c.el('[data-announcement-dialog]').open, false);
  c.el('[data-announcement-size]').value = '50'; c.el('[data-announcement-size]').fire('change'); await tick();
  assert.match(c.calls.at(-1).url, /page=1&pageSize=10/);
});
test('新增成功后下份草稿使用新ID，重复提交只发送一次', async () => {
  const c = await setup();
  for (const title of ['第一份', '第二份']) {
    c.add(); c.el('title').value = title; c.el('body').value = '正文';
    c.form.fire('submit'); c.form.fire('submit'); await tick();
    assert.equal(c.el('[data-announcement-dialog]').open, false);
  }
  const posts = c.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2); assert.notEqual(JSON.parse(posts[0].body).id, JSON.parse(posts[1].body).id);
  assert.equal(c.uuidCalls(), 2);
});
test('POST同ID异内容409不换ID、不清空草稿、不关闭弹窗', async () => {
  let stored;
  const c = await setup(async call => {
    if (call.method === 'GET') return listResponse([]);
    if (!stored) { stored = call.body; throw new Error('服务端已保存但响应丢失'); }
    assert.equal(JSON.parse(call.body).id, JSON.parse(stored).id);
    return call.body === stored ? response({ id: JSON.parse(stored).id }) : response(null, 409);
  });
  c.add(); c.el('title').value = '标题'; c.el('body').value = '原文'; c.form.fire('submit'); await tick();
  c.el('body').value = '异内容'; c.form.fire('submit'); await tick();
  assert.equal(c.el('body').value, '异内容'); assert.equal(c.el('[data-announcement-dialog]').open, true);
  assert.match(c.el('[data-announcement-form-message]').textContent, /草稿已保留/); assert.equal(c.uuidCalls(), 1);
  c.el('body').value = '原文'; c.form.fire('submit'); await tick();
  assert.equal(c.el('[data-announcement-dialog]').open, false);
});
test('刷新列表不得偷换编辑草稿加载时的revision', async () => {
  let gets = 0;
  const c = await setup(async call => call.method === 'GET'
    ? listResponse([{ ...fixture, revision: ++gets === 1 ? fixture.revision : 'b'.repeat(64) }]) : response(null, 409));
  c.action('edit'); c.el('body').value = '旧版本草稿';
  c.window.fire('pagehide'); c.window.fire('pageshow', { persisted: true }); await tick();
  assert.equal(c.el('[data-announcement-dialog]').open, true);
  c.form.fire('submit'); await tick();
  assert.equal(JSON.parse(c.calls.find(call => call.method === 'PUT').body).revision, fixture.revision);
  assert.equal(c.el('body').value, '旧版本草稿');
  c.el('[data-announcement-cancel]').fire('click'); c.action('delete'); await tick();
  assert.equal(JSON.parse(c.calls.find(call => call.method === 'DELETE').body).revision, 'b'.repeat(64));
});
test('BFCache中断在途发布后保留固定ID，迟到响应不关闭草稿', async () => {
  let finish, posts = 0;
  const c = await setup(async call => {
    if (call.method === 'GET') return listResponse([]);
    if (++posts === 1) return new Promise(resolve => { finish = resolve; });
    return response({ id: fixture.id });
  });
  c.add(); c.el('title').value = '草稿'; c.el('body').value = '正文'; c.form.fire('submit');
  assert.equal(c.el('[data-announcement-save]').disabled, true);
  c.window.fire('pagehide'); c.window.fire('pageshow', { persisted: true }); await tick();
  finish(response({ id: fixture.id })); await tick();
  assert.equal(c.el('title').value, '草稿'); assert.equal(c.el('[data-announcement-dialog]').open, true);
  assert.equal(c.el('[data-announcement-save]').disabled, false);
  c.form.fire('submit'); await tick();
  const writes = c.calls.filter(call => call.method === 'POST');
  assert.equal(writes.length, 2); assert.equal(writes[0].body, writes[1].body); assert.equal(c.uuidCalls(), 1);
});
test('401重新登录后重试仍复用固定ID', async () => {
  let posts = 0;
  const c = await setup(async call => call.method === 'GET' ? listResponse([]) : response(null, ++posts === 1 ? 401 : 200));
  c.add(); c.el('title').value = '草稿'; c.el('body').value = '正文'; c.form.fire('submit'); await tick();
  assert.equal(c.el('[data-announcement-dialog]').open, true);
  c.form.fire('submit'); await tick();
  const writes = c.calls.filter(call => call.method === 'POST'); assert.equal(writes[0].body, writes[1].body);
  assert.match(pageSource, /data-announcement-login[^>]*target="_blank"/);
});
test('缺失或非法revision拒绝加载，避免发送无版本修改', async () => {
  for (const revision of [undefined, '', 'a'.repeat(63), 'z'.repeat(64)]) {
    const c = await setup(async () => listResponse([{ ...fixture, revision }]));
    assert.equal(c.el('[data-announcement-list]').children.length, 0);
    assert.match(c.el('[data-announcement-message]').textContent, /格式异常/);
    assert.equal(c.calls.length, 1);
  }
});
