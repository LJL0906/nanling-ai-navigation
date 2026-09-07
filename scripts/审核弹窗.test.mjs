import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

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
  el('status').tagName = el('size').tagName = 'select'; el('status').value = 'pending'; el('size').value = '10';
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
    return listReply ? listReply(params) : reply({ items, total: 60, page: Number(params.get('page')), totalPages: 6 });
  } });
  await tick();
  const actions = () => el('list').children[0].children.at(-1).children[0].children;
  return { el, close, document, window, calls, confirmations, navigations, pagerStates, changePage: p => changePage(p), destroyed: () => destroyed, answer: value => { answer = value; }, actions,
    open: (review = true) => actions().find(b => b.textContent === (review ? '审核' : '详情')).fire('click'),
    submit: (value = 'approved') => el('form').fire('submit', { submitter: { value } }) };
}

test('八个有效业务列、共享样式，无行内表单和大标题说明', () => {
  assert.deepEqual([...page.matchAll(/<th\b[^>]*>(.*?)<\/th>/g)].map(m => m[1]), ['序号', '站点名称', '所属分类', '审核状态', '提交时间', '审核人', '审核时间', '操作']);
  assert.match(page, /admin-table review-table/); assert.match(page, /content-dialog/); assert.match(page, /admin-content.css/);
  assert.doesNotMatch(page.match(/<table[\s\S]*?<\/table>/)[0], /textarea|<form|<details/);
  assert.doesNotMatch(page, /<h1|查看完整提交信息/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|keyword/);
});
test('待审提供审核与详情，全部提交字段及私有备注使用纯文本，详情禁止提交', async () => {
  const c = await setup(); assert.equal(c.el('list').children[0].children.length, 8);
  assert.deepEqual(c.actions().map(b => b.textContent), ['审核', '详情']);
  c.open(); assert.equal(c.el('dialog').open, true); assert.equal(c.document.activeElement, c.el('reason'));
  const text = c.el('dialog-fields').children.map(n => n.textContent);
  for (const value of [record.name, record.url, record.iconUrl, record.remark, record.id, '私有备注']) assert.ok(text.includes(value));
  c.close.fire('click'); c.open(false); assert.equal(c.el('form').hidden, true);
  c.el('reason').value = '伪造'; c.submit(); assert.equal(c.calls.filter(x => x.method === 'PATCH').length, 0);
});
test('已通过及拒绝记录仅可查看完整详情', async () => {
  for (const status of ['approved', 'rejected']) {
    const c = await setup({ items: [{ ...record, status, reviewReason: '理由', reviewedBy: '审核员', publishedSiteId: 'site-1' }] });
    assert.deepEqual(c.actions().map(b => b.textContent), ['详情']); c.open(false);
    assert.equal(c.el('form').hidden, true); assert.ok(c.el('dialog-fields').children.some(n => n.textContent === '理由'));
  }
});
test('Escape与取消均确认未保存理由，取消确认留存、关闭恢复触发焦点', async () => {
  const c = await setup(); c.open(); const opener = c.actions()[0]; c.el('reason').value = '未保存';
  assert.equal(c.el('dialog').fire('cancel').defaultPrevented, true); assert.equal(c.el('dialog').open, true);
  c.close.fire('click'); assert.equal(c.confirmations.length, 2); assert.equal(c.el('reason').value, '未保存');
  c.answer(true); c.close.fire('click'); assert.equal(c.el('dialog').open, false); assert.equal(c.document.activeElement, opener);
  c.open(); assert.equal(c.el('reason').value, '');
});
test('必填校验、保存锁、冲突保留表单，重试通过成功关闭并刷新', async () => {
  let resolve; let attempts = 0;
  const c = await setup({ patch: () => ++attempts === 1 ? new Promise(r => { resolve = r; }) : reply({}) });
  c.open(); c.el('reason').value = '   '; c.submit(); assert.equal(attempts, 0);
  c.el('reason').value = ' 合格 '; c.el('reason').fire('input'); c.submit();
  assert.equal(c.el('reason').disabled, true); assert.equal(c.el('reset').disabled, true);
  c.submit(); c.close.fire('click'); c.el('dialog').fire('cancel'); assert.equal(attempts, 1); assert.equal(c.el('dialog').open, true);
  resolve(reply('发布冲突', 409)); await tick();
  assert.equal(c.el('reason').value, ' 合格 '); assert.match(c.el('dialog-message').textContent, /发布冲突/); assert.equal(c.el('reason').disabled, false);
  c.submit(); await tick(); assert.equal(c.el('dialog').open, false);
  assert.deepEqual(JSON.parse(c.calls.find(x => x.method === 'PATCH').body), { id: record.id, status: 'approved', reason: '合格' });
  assert.match(c.el('message').textContent, /已通过并发布/); assert.equal(c.document.activeElement, c.actions()[0]);
});
test('拒绝沿用PATCH契约，网络失败留在弹窗', async () => {
  const c = await setup({ patch: () => { throw new Error('offline'); } }); c.open(); c.el('reason').value = '拒绝理由'; c.submit('rejected'); await tick();
  assert.equal(JSON.parse(c.calls.at(-1).body).status, 'rejected'); assert.equal(c.el('dialog').open, true);
  assert.match(c.el('dialog-message').textContent, /offline/); assert.equal(c.el('reason').value, '拒绝理由');
});
test('查询应用状态和每页数，翻页不应用未查询值，重置恢复默认', async () => {
  const c = await setup(); c.el('size').value = '50'; c.el('status').value = 'approved'; c.el('filters').fire('submit'); await tick();
  assert.match(c.calls.at(-1).url, /status=approved&q=&page=1&pageSize=10/);
  c.el('status').value = 'rejected'; c.el('next').fire('click'); await tick();
  assert.match(c.calls.at(-1).url, /status=approved&q=&page=2&pageSize=10/); assert.equal(c.el('list').children[0].children[0].textContent, '11');
  c.el('filters').fire('reset'); await tick(); assert.match(c.calls.at(-1).url, /status=pending&q=&page=1&pageSize=10/);
  assert.equal(c.el('status').value, 'pending'); assert.equal(c.el('size').value, '10');
});

test('统一分页契约同步总条数和busy，数字跳转加载，销毁释放监听', async () => {
  const c = await setup();
  assert.equal(c.pagerStates.at(-1).total, 60); assert.equal(c.pagerStates.at(-1).totalPages, 6); assert.equal(c.pagerStates.at(-1).busy, false);
  c.changePage(3); assert.equal(c.pagerStates.at(-1).busy, true); await tick();
  assert.equal(c.pagerStates.at(-1).page, 3); assert.equal(c.pagerStates.at(-1).pageSize, 10);
  c.window.fire('pagehide'); assert.equal(c.destroyed(), true);
});
