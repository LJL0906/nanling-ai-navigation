import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/scripts/homeNavigation.ts', import.meta.url), 'utf8');
const sourceFile = ts.createSourceFile('homeNavigation.ts', source, ts.ScriptTarget.Latest, true);
const callbacks = [];
function visit(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
    && node.name.text === 'updateActive' && node.initializer) {
    callbacks.push(node.initializer);
  }
  ts.forEachChild(node, visit);
}
visit(sourceFile);
assert.equal(callbacks.length, 1, '应从真实源码唯一定位 updateActive 回调');
assert.ok(ts.isArrowFunction(callbacks[0]), 'updateActive 应为箭头回调');
const code = ts.transpileModule(`const updateActive = ${callbacks[0].getText(sourceFile)}; updateActive;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function anchor(dataset) {
  // 预置陈旧高亮，确保每次执行同时清理非当前项，而不只是设置选中项。
  const attributes = new Map([['aria-current', 'location']]);
  return {
    dataset: { ...dataset, homeActive: 'true' },
    setAttribute(name, value) { attributes.set(name, value); },
    removeAttribute(name) { attributes.delete(name); },
    getAttribute(name) { return attributes.get(name) ?? null; },
  };
}

function setup(tops, scrollingElement = { scrollTop: 400, clientHeight: 600, scrollHeight: 1600 }) {
  const elements = Object.entries(tops).map(([id, top]) => ({
    id, top,
    getBoundingClientRect() { return { top: this.top }; },
  }));
  const anchors = elements.map(({ id }) => anchor({ homeAnchor: id }));
  const home = anchor({ homeStart: '' });
  const context = vm.createContext({ elements, anchors, home, document: { scrollingElement }, frame: 42 });
  const updateActive = vm.runInContext(code, context);
  return { elements, anchors, home, context, updateActive };
}

function expectActive(state, active) {
  state.updateActive();
  assert.equal(state.context.frame, 0, '回调应释放待处理动画帧');
  for (const link of state.anchors) {
    const selected = link.dataset.homeAnchor === active;
    assert.equal(link.dataset.homeActive, String(selected), `${link.dataset.homeAnchor} 的 homeActive`);
    assert.equal(link.getAttribute('aria-current'), selected ? 'location' : null,
      `${link.dataset.homeAnchor} 的 aria-current`);
  }
  assert.equal(state.home.dataset.homeActive, String(!active), '首页的 homeActive');
  assert.equal(state.home.getAttribute('aria-current'), active ? null : 'page', '首页的 aria-current');
}

test('未触底：只激活 top <= 140 中最靠近阈值的分区，包含 140px 边界', () => {
  const state = setup({ first: -240, current: 140, next: 140.01, last: 510 });
  expectActive(state, 'current');
  state.elements.find(({ id }) => id === 'current').top = 140.01;
  expectActive(state, 'first');
});

test('到底：未达到 140px 激活线的最后短分区也应高亮', () => {
  const state = setup({ first: -500, previous: 80, short: 520 },
    { scrollTop: 1000, clientHeight: 600, scrollHeight: 1600 });
  expectActive(state, 'short');
});

for (const [gap, expected] of [[0, 'short'], [1, 'short'], [2, 'short'], [2.01, 'previous'], [3, 'previous']]) {
  test(`触底容差：距离底部 ${gap}px 时高亮 ${expected}`, () => {
    expectActive(setup({ previous: 80, short: 520 },
      { scrollTop: 1000 - gap, clientHeight: 600, scrollHeight: 1600 }), expected);
  });
}

test('视觉重排：触底按实际 top 最大值选择，不取 elements 数组末项', () => {
  const state = setup({ visualLast: 520, visualFirst: -500, visualMiddle: 80 },
    { scrollTop: 1000, clientHeight: 600, scrollHeight: 1600 });
  expectActive(state, 'visualLast');
  // elements 保持原顺序，仅布局变化；再次执行必须读取新位置。
  state.elements[0].top = 80;
  state.elements[2].top = 520;
  expectActive(state, 'visualMiddle');
});

test('视觉重排且未触底：仍选择 top <= 140 中 top 最大的分区', () => {
  expectActive(setup({ current: 130, next: 500, first: -300 }), 'current');
});

for (const scrollHeight of [600, 601, 500]) {
  test(`顶端不误判触底：首页在 scrollTop=0、scrollHeight=${scrollHeight} 时保持高亮`, () => {
    expectActive(setup({ first: 180, last: 420 },
      { scrollTop: 0, clientHeight: 600, scrollHeight }), '');
  });
}

test('从底部回到顶部：清除分区 aria-current 并恢复首页 page 与 homeActive', () => {
  const scroller = { scrollTop: 1000, clientHeight: 600, scrollHeight: 1600 };
  const state = setup({ first: -500, last: 520 }, scroller);
  expectActive(state, 'last');
  scroller.scrollTop = 0;
  state.elements[0].top = 180;
  state.elements[1].top = 1200;
  expectActive(state, '');
});

test('没有 scrollingElement 时安全退回原阈值逻辑', () => {
  expectActive(setup({ current: 120, last: 520 }, null), 'current');
});
