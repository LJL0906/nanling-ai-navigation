import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = (await readFile(new URL('../src/styles/topbar.css', import.meta.url), 'utf8'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

// 按花括号提取媒体块，避免跨断点误匹配；不约束缩进、换行或声明顺序。
function mediaBlocks(source) {
  const blocks = [];
  const pattern = /@media\s*([^{}]+)\{/g;
  for (let match; (match = pattern.exec(source));) {
    const start = pattern.lastIndex;
    let depth = 1;
    let end = start;
    while (end < source.length && depth) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
      end++;
    }
    assert.equal(depth, 0, '媒体查询必须闭合');
    blocks.push({ query: match[1], body: source.slice(start, end - 1) });
    pattern.lastIndex = end;
  }
  return blocks;
}

const blocks = mediaBlocks(css);
const mobile = blocks.filter(({ query }) => /\(\s*max-width\s*:\s*767px\s*\)/.test(query))
  .map(({ body }) => body).join('\n');
const tablet = blocks.filter(({ query }) => /\(\s*max-width\s*:\s*1279px\s*\)/.test(query))
  .map(({ body }) => body).join('\n');

function declarations(source, selector) {
  const result = new Map();
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.split(',').some(item => item.trim().replace(/\s+/g, ' ') === selector)) continue;
    for (const declaration of body.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      result.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()
        .replace(/\s*!important\s*$/, '').replace(/\s+/g, ' '));
    }
  }
  return result;
}

function expectProperties(source, selector, expected) {
  const actual = declarations(source, selector);
  for (const [property, value] of Object.entries(expected)) {
    assert.equal(actual.get(property), value, `${selector} 的 ${property} 应为 ${value}`);
  }
}

// 静态源码契约，不替代真实设备的布局、缩放或浮层定位验收。
test('767px 移动断点释放操作容器，使搜索参与 header 的 flex 排序', () => {
  assert.ok(mobile, '缺少 max-width: 767px 媒体查询');
  expectProperties(mobile, '.topbar__actions', { display: 'contents' });
});

test('移动搜索独占一行，排在操作入口之后且保持 44px 高度', () => {
  expectProperties(mobile, '.cyber-topbar.topbar .nav-search', {
    order: '1', flex: '0 0 100%', width: '100%', height: '44px',
  });
  const margin = declarations(mobile, '.cyber-topbar.topbar .nav-search').get('margin');
  assert.match(margin ?? '', /^0(?:px)?(?: 0(?:px)?){0,3}$/, '搜索外边距应全部清零');
});

test('移动抽屉入口使用右侧自动外边距分隔用户操作', () => {
  expectProperties(mobile, '.topbar__drawer', { 'margin-right': 'auto' });
});

test('导航链接沿用较宽断点的第三行排序，位于搜索之后', () => {
  expectProperties(`${tablet}\n${mobile}`, '.topbar__links', { order: '2' });
});

test('移动搜索输入字号保持 16px', () => {
  expectProperties(mobile, '.cyber-topbar.topbar .nav-search input', { 'font-size': '16px' });
});

test('移动用户浮层不再以用户入口为定位容器，而是从 header 底部展开', () => {
  expectProperties(mobile, '.floating-nav--user', { position: 'static' });
  const panel = declarations(mobile, '.floating-nav--user .floating-nav__panel');
  assert.match(panel.get('top') ?? '', /^(?:100%|calc\(\s*100%\s*\+\s*\d+(?:\.\d+)?px\s*\))$/,
    '用户浮层应从 header 的 100% 高度向下展开，不固定某个像素偏移');
});

