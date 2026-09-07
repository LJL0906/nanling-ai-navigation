import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const paths = {
  template: '../src/components/home/HomeNavigation.astro',
  tabs: '../src/scripts/homeTabs.ts',
  navigation: '../src/scripts/homeNavigation.ts',
  css: '../src/styles/home-navigation.css',
};
const read = (name) => {
  const url = new URL(paths[name], import.meta.url);
  assert.ok(existsSync(url), `约定文件尚未提供：${paths[name]}`);
  return readFileSync(url, 'utf8');
};
const rules = (source, selector) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, selectors]) => selectors.split(',').some((item) => selector.test(item.trim())))
  .map(([, , body]) => body).join('\n');

// 仅检查源码契约，不将静态断言当作浏览器滚动或视觉验收。
test('分类栏由 home-section-tabbar 同时包裹左右按钮和 tablist', () => {
  const source = read('template');
  const opening = /<div\b[^>]*class=["'][^"']*\bhome-section-tabbar\b[^"']*["'][^>]*>/g;
  const match = opening.exec(source);
  assert.ok(match, '缺少 .home-section-tabbar 容器');
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = opening.lastIndex;
  let depth = 1;
  let end = -1;
  for (let tag; (tag = tags.exec(source));) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { end = tag.index; break; }
  }
  assert.ok(end >= 0, '分类栏容器必须闭合');
  const content = source.slice(opening.lastIndex, end);
  assert.match(content, /class=["'][^"']*\bhome-section-tabs\b/);
  assert.match(content, /role=["']tablist["']/);
  assert.match(content, /data-home-tabs-prev/);
  assert.match(content, /data-home-tabs-next/);
  assert.ok(content.indexOf('data-home-tabs-prev') < content.search(/role=["']tablist["']/)
    && content.indexOf('data-home-tabs-next') > content.search(/role=["']tablist["']/),
  '左右按钮应分别位于 tablist 前后');
});

test('tablist 使用分类唯一 ID，保留可访问名称', () => {
  const tag = read('template').match(/<\w+\b[^>]*role=["']tablist["'][^>]*>/)?.[0];
  assert.ok(tag, '缺少 tablist');
  assert.match(tag, /\bid=\{`home-tabs-\$\{category\.slug\}`\}/);
  assert.match(tag, /aria-label\s*=/);
});

for (const direction of ['prev', 'next']) {
  test(`${direction} 滚动按钮默认隐藏，声明按钮类型、名称和受控 tablist`, () => {
    const buttons = [...read('template').matchAll(/<button\b[^>]*>/g)]
      .map(([tag]) => tag).filter((tag) => tag.includes(`data-home-tabs-${direction}`));
    assert.equal(buttons.length, 1, `应唯一声明 data-home-tabs-${direction}`);
    assert.match(buttons[0], /\btype=["']button["']/);
    assert.match(buttons[0], /\saria-label=(?:["'][^"']+["']|\{[^}]+\})/);
    assert.match(buttons[0], /aria-controls=\{`home-tabs-\$\{category\.slug\}`\}/);
    assert.match(buttons[0], /\shidden(?:\s|>|=\{true\})/);
  });
}

test('homeTabs 导出约定的元素与 AbortSignal 初始化入口', () => {
  assert.match(read('tabs'), /export\s+(?:function\s+initHomeTabs\s*|(?:const|let)\s+initHomeTabs\s*=\s*)\(\s*element\s*:\s*HTMLElement\s*,\s*signal\s*:\s*AbortSignal\s*\)/);
});

test('分类栏绑定滚动及左右点击，利用实际尺寸更新溢出和 disabled 边界', () => {
  const source = read('tabs');
  assert.match(source, /data-home-tabs-prev/);
  assert.match(source, /data-home-tabs-next/);
  assert.match(source, /addEventListener\(\s*['"]scroll['"]/);
  assert.ok([...source.matchAll(/addEventListener\(\s*['"]click['"]/g)].length >= 2,
    '左右按钮均需绑定点击');
  assert.match(source, /\.scroll(?:By|To)\s*\(|\.scrollLeft\s*[+\-]?=/);
  for (const property of ['scrollWidth', 'clientWidth', 'scrollLeft']) {
    assert.ok(source.includes(property), `边界计算需要 ${property}`);
  }
  assert.ok([...source.matchAll(/\.disabled\s*=/g)].length >= 2,
    '左右按钮均需更新 disabled 边界');
  assert.match(source, /\.hidden\s*=|toggleAttribute\(\s*['"]hidden['"]/);
  assert.match(source, /signal/);
});

test('分类栏观察尺寸变化，并返回可断开观察器的清理函数', () => {
  const source = read('tabs');
  assert.match(source, /new\s+ResizeObserver\s*\(/);
  assert.match(source, /\.observe\s*\(/);
  assert.match(source, /\.disconnect\s*\(/);
  assert.match(source, /return\s+(?:\([^)]*\)\s*=>|function\b|[\w$]+\s*;)/);
  const signalOptions = source.match(/(?:const|let)\s+(\w+)\s*=\s*\{\s*signal\s*\}/)?.[1];
  assert.ok(/addEventListener\([\s\S]*?\{[^}]*\bsignal\b/.test(source)
    || (signalOptions && new RegExp('addEventListener\\([\\s\\S]*?\\b' + signalOptions + '\\b').test(source)),
  '事件监听应接入传入的 AbortSignal（支持共享 options）');
});

test('homeNavigation 初始化分类栏，并在 dispose 时调用返回的清理函数', () => {
  const source = read('navigation');
  assert.match(source, /import\s*\{[^}]*\binitHomeTabs\b[^}]*\}\s*from\s*['"]\.\/homeTabs(?:\.ts)?['"]/);
  assert.match(source, /initHomeTabs\(\s*\w+\s*,\s*controller\.signal\s*\)/);
  const disposal = source.slice(source.indexOf('disposeHome = () =>'));
  assert.ok(disposal.length > 0, '缺少 disposeHome 清理入口');
  const direct = [...source.matchAll(/(?:const|let)\s+(\w+)\s*=\s*initHomeTabs\(/g)]
    .some(([, name]) => new RegExp(`\\b${name}\\s*\\??\\.?\\(`).test(disposal));
  const collected = [...source.matchAll(/(\w+)\.push\(\s*initHomeTabs\(/g)]
    .some(([, name]) => new RegExp(`\\b${name}\\.forEach\\([\\s\\S]*?=>\\s*\\{?\\s*\\w+\\(`).test(disposal)
      || new RegExp(`for\\s*\\([^)]*\\bof\\s+${name}\\)[\\s\\S]*?\\w+\\(`).test(disposal));
  assert.ok(direct || collected, 'initHomeTabs 返回的清理函数须保存并在 disposeHome 内调用');
  assert.match(disposal, /controller\.abort\(\)/);
  assert.match(source, /astro:before-swap[\s\S]*?disposeHome\?\.\(\)/);
});

test('分类栏允许横向滚动，但隐藏 Firefox 和 WebKit 原生滚动条', () => {
  const css = read('css');
  const tabs = rules(css, /^\.home-section-tabs$/);
  assert.match(tabs, /overflow-x\s*:\s*auto/);
  assert.match(tabs, /scrollbar-width\s*:\s*none/);
  assert.match(rules(css, /^\.home-section-tabs::\-webkit-scrollbar$/),
    /display\s*:\s*none|height\s*:\s*0(?:px)?\b/);
});

test('分类 Tab 使用胶囊圆角和选中背景', () => {
  const css = read('css');
  const tab = rules(css, /^\.home-section-tab$/);
  const selected = rules(css, /^\.home-section-tab\[aria-selected\s*=\s*['"]true['"]\]$/);
  assert.match(`${tab}\n${selected}`, /border-radius\s*:\s*(?:999\d*px|[2-9]\d{2,}px|50%)/);
  assert.match(selected, /background(?:-color)?\s*:/);
});

test('分类 Tab 提供 focus-visible 键盘焦点提示', () => {
  const css = read('css');
  assert.match(rules(css, /^\.home-section-tab:focus-visible$/), /outline\s*:\s*(?!none\b|0\b)|box-shadow\s*:\s*(?!none\b)/);
});

test('暗色主题为分类 Tab 和选中胶囊提供独立状态', () => {
  const css = read('css');
  assert.match(rules(css, /^\.dark\s+\.home-section-tab$/), /color\s*:/);
  const selected = rules(css, /^\.dark\s+\.home-section-tab\[aria-selected\s*=\s*['"]true['"]\]$/);
  assert.match(selected, /color\s*:/);
  assert.match(selected, /background(?:-color)?\s*:/);
});


