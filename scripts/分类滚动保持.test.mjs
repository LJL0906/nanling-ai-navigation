import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/scripts/category.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function category(slug = 'ai', scrollLeft = 0, label = '共 48 个') {
  const attributes = new Map();
  const tabs = { dataset: { categoryTabs: slug }, scrollLeft };
  const list = {
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
  const elements = {
    '[data-category-tabs]': tabs,
    '[data-category-sites]': list,
    '[data-results-label]': { textContent: label },
  };
  const root = { querySelector(selector) { return elements[selector] ?? null; } };
  return { tabs, list, root, elements };
}

function setup(initial = category(), path = '/ai/?tab=all') {
  let page = initial;
  const listeners = new Map();
  const frames = [];
  const location = new URL(path, 'https://navigation.test');
  const document = {
    querySelector(selector) {
      if (!page) return null;
      return selector === '[data-category-page]' ? page.root : page.root.querySelector(selector);
    },
    addEventListener(type, callback) {
      const callbacks = listeners.get(type) ?? [];
      callbacks.push(callback);
      listeners.set(type, callbacks);
    },
  };
  const context = {
    document, location, URL,
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
  };
  // 若实现访问持久化存储，立即失败，而非提供可用的假存储掩盖回归。
  for (const name of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(context, name, {
      get() { assert.fail(`分类滚动恢复不应访问 ${name}`); },
    });
  }
  context.window = context;
  vm.runInNewContext(code, context, { filename: 'category.js' });

  function emit(type) {
    for (const callback of listeners.get(type) ?? []) callback({ type });
    let count = 0;
    while (frames.length) {
      assert.ok(count++ < 100, '动画帧应在有限次数内完成');
      frames.shift()(0);
    }
  }
  function replace(next, nextPath = path) {
    page = next;
    location.href = new URL(nextPath, location).href;
    path = nextPath;
  }
  function navigate(next, nextPath = path) {
    emit('astro:before-swap');
    replace(next, nextPath);
    emit('astro:after-swap');
  }
  return { emit, replace, navigate };
}

test('同分类换 tab：新 DOM 在 after-swap 恢复水平位置，page-load 后仍保持', () => {
  const previous = category('ai', 245);
  const app = setup(previous);
  const next = category('ai');
  app.navigate(next, '/ai/?tab=writing');
  assert.notEqual(next.tabs, previous.tabs, '必须使用新页面节点，不持久化旧 DOM');
  assert.equal(next.tabs.scrollLeft, 245);
  app.emit('astro:page-load');
  assert.equal(next.tabs.scrollLeft, 245);
});

test('同分类分页：URL 路径与查询参数改变不影响按 slug 恢复', () => {
  const app = setup(category('development', 318), '/development/?tab=tools');
  const next = category('development');
  app.navigate(next, '/development/page/2/?tab=tools');
  assert.equal(next.tabs.scrollLeft, 318);
  app.emit('astro:page-load');
  assert.equal(next.tabs.scrollLeft, 318);
});

test('before-swap 保存数值快照：之后旧节点的位置与 slug 变化不影响恢复', () => {
  const previous = category('ai', 127.5);
  const app = setup(previous);
  app.emit('astro:before-swap');
  previous.tabs.scrollLeft = 999;
  previous.tabs.dataset.categoryTabs = 'other';
  const next = category('ai');
  app.replace(next);
  app.emit('astro:after-swap');
  assert.equal(next.tabs.scrollLeft, 127.5);
});

test('多次同分类切换：每次保存最新位置，0 值也覆盖上次非零位置', () => {
  let current = category('ai');
  const app = setup(current);
  for (const [index, position] of [280, 0, 91, 0, 412].entries()) {
    current.tabs.scrollLeft = position;
    const next = category('ai', 17);
    app.navigate(next, `/ai/?tab=tab-${index}`);
    assert.equal(next.tabs.scrollLeft, position, `第 ${index + 1} 次 after-swap`);
    app.emit('astro:page-load');
    assert.equal(next.tabs.scrollLeft, position, `第 ${index + 1} 次 page-load`);
    current = next;
  }
});

test('跨分类不串位置：保留目标初始位置，返回原分类也不使用历史缓存', () => {
  const app = setup(category('ai', 360));
  const development = category('development', 23);
  app.navigate(development, '/development/');
  assert.equal(development.tabs.scrollLeft, 23);
  app.emit('astro:page-load');
  assert.equal(development.tabs.scrollLeft, 23);
  development.tabs.scrollLeft = 88;
  const back = category('ai');
  app.navigate(back, '/ai/');
  assert.equal(back.tabs.scrollLeft, 0);
  app.emit('astro:page-load');
  assert.equal(back.tabs.scrollLeft, 0);
});

test('非分类页初始化与生命周期事件不报错，进入分类页不凭空恢复', () => {
  const app = setup(null, '/');
  assert.doesNotThrow(() => {
    app.emit('astro:page-load');
    app.navigate(null, '/about/');
    app.emit('astro:page-load');
  });
  const next = category('ai', 19);
  app.navigate(next, '/ai/');
  app.emit('astro:page-load');
  assert.equal(next.tabs.scrollLeft, 19);
});

test('分类页经过非分类页后返回：清除旧快照，不恢复离开前的滚动位置', () => {
  const app = setup(category('ai', 205));
  assert.doesNotThrow(() => {
    app.navigate(null, '/');
    app.emit('astro:page-load');
  });
  const next = category('ai');
  app.navigate(next, '/ai/');
  assert.equal(next.tabs.scrollLeft, 0);
  app.emit('astro:page-load');
  assert.equal(next.tabs.scrollLeft, 0);
});

test('page-load 独立恢复：不依赖 after-swap 已经设置位置', () => {
  const app = setup(category('ai', 156));
  app.emit('astro:before-swap');
  const next = category('ai');
  app.replace(next, '/ai/?tab=images');
  app.emit('astro:page-load');
  assert.equal(next.tabs.scrollLeft, 156);
});

test('after-swap 后位置被重置：page-load 再次恢复同一快照', () => {
  const app = setup(category('ai', 234));
  const next = category('ai');
  app.navigate(next, '/ai/?tab=audio');
  assert.equal(next.tabs.scrollLeft, 234);
  next.tabs.scrollLeft = 0;
  app.emit('astro:page-load');
  assert.equal(next.tabs.scrollLeft, 234);
});

test('保留列表 aria-label：首次初始化及换页后使用当前结果文案', () => {
  const initial = category('ai', 52, '共 120 个');
  const app = setup(initial);
  assert.equal(initial.list.getAttribute('aria-label'), '共 120 个站点列表');
  const next = category('ai', 0, '共 7 个');
  app.navigate(next, '/ai/?tab=writing');
  app.emit('astro:page-load');
  assert.equal(next.list.getAttribute('aria-label'), '共 7 个站点列表');
});
