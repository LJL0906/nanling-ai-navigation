import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

// 完整运行生产脚本，不提取或调用内部函数；仅通过 DOM 事件和持久化结果断言。
const code = stripTypeScriptTypes(readFileSync(
  new URL('../src/scripts/searchHistory.ts', import.meta.url), 'utf8'));
const KEY = 'nav-search-history';
const response = (index = {}) => ({ ok: true, json: async () => index });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup({ history = [], index, fetcher = async () => response(), storageFails = false } = {}) {
  const errors = [];
  class Element {
    constructor(tag = 'div') {
      this.tagName = tag.toUpperCase();
      this.dataset = {};
      this.children = [];
      this.hidden = false;
      this.isConnected = true;
      this.attributes = new Map();
      this.listeners = new Map();
      this.selectors = new Map();
    }
    addEventListener(type, callback) {
      const callbacks = this.listeners.get(type) ?? [];
      callbacks.push(callback);
      this.listeners.set(type, callbacks);
    }
    dispatch(type, properties = {}) {
      const event = {
        type, target: this, currentTarget: this, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; }, ...properties,
      };
      for (const callback of this.listeners.get(type) ?? []) {
        const result = callback(event);
        if (result?.then) result.catch((error) => errors.push(error));
      }
      return event;
    }
    querySelector(selector) { return this.selectors.get(selector) ?? null; }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    focus() { this.focused = true; }
  }
  class Anchor extends Element { constructor() { super('a'); } }
  const document = new Element('document');
  const scope = new Element();
  const form = new Element('form');
  const input = new Element('input');
  const button = new Element('button');
  const tags = new Element();
  const container = new Element();
  const empty = new Element('p');
  const popover = new Element('details');
  const summary = new Element('summary');
  input.value = '';
  popover.open = false;
  popover.selectors.set('summary', summary);
  form.selectors.set('input[name="q"]', input);
  form.closest = (selector) => selector === '[data-nav-search]' ? scope : null;
  document.selectors.set('[data-search-history-form]', form);
  for (const [selector, node] of [
    ['[data-search-history]', container], ['[data-search-history-tags]', tags],
    ['[data-search-history-empty]', empty], ['[data-history-popover]', popover],
  ]) scope.selectors.set(selector, node);
  if (index !== undefined) tags.dataset.historyDestinations = JSON.stringify(index);
  document.createElement = (tag) => tag === 'a' ? new Anchor() : new Element(tag);
  const storage = new Map([[KEY, JSON.stringify(history)]]);
  const requests = [];
  const resumed = [];
  const navigations = [];
  function dispatchSubmit(submitter = button, properties = {}) {
    const event = form.dispatch('submit', { submitter, ...properties });
    // 浏览器在同步派发结束后判断默认行为，不会等待 async 监听器。
    if (!event.defaultPrevented) navigations.push({ query: input.value, submitter });
    return event;
  }
  form.requestSubmit = (submitter) => {
    resumed.push(submitter);
    assert.ok(resumed.length <= 5, '恢复提交不可递归失控');
    return dispatchSubmit(submitter);
  };
  runInNewContext(code, {
    document, URL, AbortSignal, HTMLElement: Element, HTMLAnchorElement: Anchor,
    HTMLFormElement: Element, HTMLInputElement: Element,
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem(key, value) {
        if (storageFails) throw new Error('存储不可用');
        storage.set(key, value);
      },
    },
    fetch(url, options) {
      requests.push({ url, options });
      return fetcher(url, options);
    },
  }, { filename: 'searchHistory.ts' });
  return {
    document, form, input, button, tags, container, empty, popover, summary,
    requests, resumed, navigations,
    history: () => JSON.parse(storage.get(KEY)),
    submit(word, properties) { input.value = word; return dispatchSubmit(button, properties); },
    open() { popover.open = true; popover.dispatch('toggle'); },
    async settle() {
      await new Promise((resolve) => setImmediate(resolve));
      if (errors.length) throw errors[0];
    },
  };
}

function expectLinks(state, expected) {
  assert.deepEqual(state.tags.children.map((link) => [link.textContent, link.href]), expected);
  for (const link of state.tags.children) {
    assert.equal(link.tagName, 'A', '历史只渲染链接，不能留下禁用 span');
    assert.equal(link.target, '_blank');
    assert.ok(link.rel.split(/\s+/).includes('noopener'));
    assert.ok(link.rel.split(/\s+/).includes('noreferrer'));
    assert.equal(link.getAttribute('aria-disabled'), null);
  }
  assert.equal(state.container.hidden, expected.length === 0);
  assert.equal(state.empty.hidden, expected.length !== 0);
}

test('直接 http(s) URL 和域名：保存为链接，不请求索引、不阻塞搜索', async () => {
  for (const [word, href] of [
    ['https://example.com/path?q=1', 'https://example.com/path?q=1'],
    ['http://example.com/', 'http://example.com/'],
    ['example.com/tools', 'https://example.com/tools'],
  ]) {
    const state = setup();
    assert.equal(state.submit(`  ${word}  `).defaultPrevented, false);
    await state.settle();
    assert.deepEqual(state.history(), [word]);
    expectLinks(state, [[word, href]]);
    assert.equal(state.requests.length, 0);
    assert.equal(state.resumed.length, 0);
    assert.deepEqual(state.navigations, [{ query: word, submitter: state.button }]);
  }
});

test('首次关键词提交：等待索引命中，保存链接并携原 submitter 恢复一次', async () => {
  const pending = deferred();
  const state = setup({ fetcher: () => pending.promise });
  assert.equal(state.submit('  GitHub  ').defaultPrevented, true);
  assert.equal(state.navigations.length, 0);
  assert.deepEqual(state.history(), []);
  assert.equal(state.requests.length, 1);
  assert.equal(state.requests[0].url, '/history-destinations.json');
  assert.ok(state.requests[0].options.signal instanceof AbortSignal);
  pending.resolve(response({ github: 'https://github.com/' }));
  await state.settle();
  assert.deepEqual(state.history(), ['GitHub']);
  expectLinks(state, [['GitHub', 'https://github.com/']]);
  assert.deepEqual(state.resumed, [state.button]);
  assert.deepEqual(state.navigations, [{ query: 'GitHub', submitter: state.button }]);
});

test('无链接、歧义和危险 URL：不保存、不渲染，但正常恢复搜索', async () => {
  for (const word of ['普通搜索词', '歧义站点', '危险站点', 'javascript:alert(1)',
    'ftp://example.com/', 'https://user:password@example.com/', 'https://']) {
    const state = setup({ fetcher: async () => response({
      歧义站点: null, 危险站点: 'javascript:alert(1)',
    }) });
    state.submit(word);
    await state.settle();
    assert.deepEqual(state.history(), [], word);
    expectLinks(state, []);
    assert.deepEqual(state.navigations, [{ query: word, submitter: state.button }]);
    assert.deepEqual(state.resumed, [state.button]);
  }
});

test('旧历史初始化主动加载：成功前隐藏但不删除，成功后清除无链接记录', async () => {
  const pending = deferred();
  const history = ['旧关键词', 'GitHub', 'example.com', '歧义站点', '危险站点'];
  const state = setup({ history, fetcher: () => pending.promise });
  assert.equal(state.requests.length, 1);
  assert.deepEqual(state.history(), history);
  expectLinks(state, [['example.com', 'https://example.com/']]);
  pending.resolve(response({ github: 'https://github.com/', 歧义站点: null, 危险站点: 'data:text/html,bad' }));
  await state.settle();
  assert.deepEqual(state.history(), ['GitHub', 'example.com']);
  expectLinks(state, [['GitHub', 'https://github.com/'], ['example.com', 'https://example.com/']]);
  state.open();
  await state.settle();
  assert.equal(state.requests.length, 1, '成功加载后不重复请求');

  const emptyState = setup({ history: ['旧词'] });
  await emptyState.settle();
  assert.deepEqual(emptyState.history(), []);
  expectLinks(emptyState, []);
});

test('网络、HTTP、JSON 和超时失败：保留原历史，仍恢复正常搜索', async () => {
  for (const fetcher of [
    async () => { throw new Error('offline'); },
    async () => ({ ok: false, json: async () => ({}) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('bad JSON'); } }),
    async () => { throw new DOMException('timeout', 'TimeoutError'); },
  ]) {
    const history = ['GitHub', 'example.com'];
    const state = setup({ history, fetcher });
    await state.settle();
    assert.deepEqual(state.history(), history);
    expectLinks(state, [['example.com', 'https://example.com/']]);
    assert.equal(state.submit('新的普通搜索').defaultPrevented, true);
    await state.settle();
    assert.deepEqual(state.history(), history);
    assert.deepEqual(state.resumed, [state.button]);
    assert.deepEqual(state.navigations, [{ query: '新的普通搜索', submitter: state.button }]);
  }
});

test('索引等待期间重复提交：只请求一次且只恢复一次导航', async () => {
  const pending = deferred();
  const state = setup({ fetcher: () => pending.promise });
  assert.equal(state.submit('GitHub').defaultPrevented, true);
  assert.equal(state.submit('GitHub').defaultPrevented, true);
  assert.equal(state.requests.length, 1);
  pending.resolve(response({ github: 'https://github.com/' }));
  await state.settle();
  assert.deepEqual(state.history(), ['GitHub']);
  assert.equal(state.resumed.length, 1);
  assert.equal(state.navigations.length, 1);
});
