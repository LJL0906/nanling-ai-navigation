import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const paths = {
  template: '../src/components/category/CategoryPage.astro',
  script: '../src/scripts/category.ts',
  css: '../src/styles/category-tabs.css',
};
const read = (name) => {
  const url = new URL(paths[name], import.meta.url);
  assert.ok(existsSync(url), `约定文件尚未提供：${paths[name]}`);
  return readFileSync(url, 'utf8');
};
const rules = (source, selector) => [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, selectors]) => selectors.split(',').some((item) => selector.test(item.trim())))
  .map(([, , body]) => body).join('\n');
const tags = (source, name) => [...source.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))]
  .map(([tag]) => tag);
const attribute = (tag, name) => tag.match(new RegExp(
  `(?:^|\\s)${name}\\s*=\\s*("[^"]*"|'[^']*'|\\{(?:[^{}]|\\{[^{}]*\\})*\\})`,
))?.[1];
const tabNav = (source) => {
  const nav = tags(source, 'nav').filter((tag) => /\sdata-category-tabs(?:\s|=|>)/.test(tag));
  assert.equal(nav.length, 1, '应唯一声明 data-category-tabs 滚动导航');
  return nav[0];
};
const button = (source, direction) => {
  const found = tags(source, 'button').filter((tag) => tag.includes(`data-category-tabs-${direction}`));
  assert.equal(found.length, 1, `应唯一声明 ${direction} 滚动按钮`);
  return found[0];
};
const blockAfter = (source, opening) => {
  let depth = 1;
  for (let index = opening + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(opening + 1, index);
  }
  assert.fail('样式块未闭合');
};

// 源码契约不是浏览器行为测试；不固定局部变量、函数名或滚动步长。
test('独立页引入 category-tabs.css，胶囊样式由独立文件提供', () => {
  assert.match(read('template'), /import\s+['"][^'"]*\/category-tabs\.css['"]/);
  assert.match(rules(read('css'), /^\.category-tab$/), /border-radius\s*:\s*(?:999\d*px|[2-9]\d{2,}px|50%)/);
});

test('category-tabbar 同时包裹前后按钮和滚动 nav', () => {
  const source = read('template');
  const opening = /<div\b[^>]*class=["'][^"']*\bcategory-tabbar\b[^"']*["'][^>]*>/g;
  const match = opening.exec(source);
  assert.ok(match, '缺少 .category-tabbar 容器');
  const divs = /<\/?div\b[^>]*>/g;
  divs.lastIndex = opening.lastIndex;
  let depth = 1;
  let end = -1;
  for (let tag; (tag = divs.exec(source));) {
    depth += tag[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { end = tag.index; break; }
  }
  assert.ok(end >= 0, '切换栏容器必须闭合');
  const content = source.slice(opening.lastIndex, end);
  const nav = tabNav(content);
  assert.ok(content.indexOf(button(content, 'prev')) < content.indexOf(nav), '上一组按钮应在 nav 前');
  assert.ok(content.indexOf(button(content, 'next')) > content.indexOf('</nav>'), '下一组按钮应在 nav 后');
});

test('滚动 nav 保留分类标识、非空 ID 和可访问名称', () => {
  const nav = tabNav(read('template'));
  for (const name of ['id', 'aria-label', 'data-category-tabs']) {
    assert.ok(attribute(nav, name), `nav 缺少 ${name}`);
    assert.doesNotMatch(attribute(nav, name), /^["']\s*["']$|^\{\s*\}$/);
  }
  assert.doesNotMatch(nav, /role=["']tablist["']/, 'URL 导航不应冒充客户端 tablist');
});

for (const direction of ['prev', 'next']) {
  test(`${direction} 按钮默认隐藏，声明类型、名称和匹配 nav 的 aria-controls`, () => {
    const source = read('template');
    const tag = button(source, direction);
    assert.match(tag, /\btype\s*=\s*["']button["']/);
    assert.ok(attribute(tag, 'aria-label'), '滚动按钮需要可访问名称');
    assert.doesNotMatch(attribute(tag, 'aria-label'), /^["']\s*["']$/);
    const controlled = attribute(tag, 'aria-controls');
    assert.ok(controlled, '滚动按钮需要 aria-controls');
    const normalize = (value) => value?.replace(/\s/g, '').replace(/^['"]|['"]$/g, '');
    assert.equal(normalize(controlled), normalize(attribute(tabNav(source), 'id')));
    assert.match(tag, /\shidden(?:\s|>|=\{true\})/, '增强脚本执行前按钮应隐藏');
  });
}

test('分类胶囊保留真实 URL 链接、aria-current 和服务端筛选分页', () => {
  const source = read('template');
  const tab = tags(source, 'a').find((tag) => /\sdata-category-tab=/.test(tag));
  assert.ok(tab, '分类选项应为 a 链接');
  assert.ok(attribute(tab, 'href'), '分类链接必须提供服务端导航地址');
  assert.match(tab, /\bcategory-tab\b/);
  assert.match(attribute(tab, 'aria-current') ?? '', /['"]true['"]/);
  assert.doesNotMatch(tab, /role=["']tab["']|aria-selected/);
  assert.match(source, /Astro\.url\.searchParams\.get\(\s*['"]sub['"]\s*\)/);
  assert.match(source, /paginateCategory\s*\(/);
  assert.match(source, /\?sub=\$\{encodeURIComponent\(/);
  assert.match(source, /\/page\/\$\{/);
  assert.doesNotMatch(read('script'), /\.preventDefault\s*\(|history\.(?:pushState|replaceState)\s*\(|\bfetch\s*\(/,
    '切换栏增强不应接管 URL 导航或另行请求筛选结果');
});

test('Astro DOM 切换前保存横向位置，切换后恢复并按分类隔离', () => {
  const source = read('script');
  for (const event of ['astro:before-swap', 'astro:after-swap', 'astro:page-load']) {
    assert.ok(source.includes(event), `缺少 ${event} 生命周期`);
  }
  assert.match(source, /\.scrollLeft\s*=/, '应恢复横向滚动位置');
  assert.match(source, /(?:[:=]\s*[\w$?.]+\.scrollLeft\b)/, '应读取并保存横向位置');
  assert.match(source, /(?:dataset\.categoryTabs|getAttribute\(\s*['"]data-category-tabs['"]\s*\))/);
  assert.match(source, /(?:===|!==)[^;\n]*(?:dataset\.categoryTabs|getAttribute\(\s*['"]data-category-tabs['"])/,
    '恢复前应比较分类，避免将另一分类的位置带入');
});

test('左右按钮使用 scrollBy，滚动事件和实际尺寸驱动隐藏与禁用边界', () => {
  const source = read('script');
  for (const direction of ['prev', 'next']) assert.ok(source.includes(`data-category-tabs-${direction}`));
  assert.match(source, /\.scrollBy\s*\(/);
  assert.match(source, /addEventListener\(\s*['"]scroll['"]/);
  assert.ok([...source.matchAll(/addEventListener\(\s*['"]click['"]/g)].length >= 2,
    '左右按钮均需绑定点击');
  for (const property of ['scrollWidth', 'clientWidth', 'scrollLeft']) assert.ok(source.includes(property), `缺少 ${property}`);
  assert.ok([...source.matchAll(/\.disabled\s*=|(?:setAttribute|toggleAttribute)\(\s*['"]disabled['"]/g)].length >= 2,
    '需要分别更新左右按钮的禁用状态');
  assert.match(source, /\.hidden\s*=|toggleAttribute\(\s*['"]hidden['"]/);
});

test('ResizeObserver 观察尺寸，并与 AbortController 一起提供清理', () => {
  const source = read('script');
  assert.match(source, /new\s+ResizeObserver\s*\(/);
  assert.match(source, /\.observe\s*\(/);
  assert.match(source, /\.disconnect\s*\(/);
  assert.match(source, /new\s+AbortController\s*\(/);
  assert.match(source, /\.abort\s*\(/);
  assert.match(source, /\bsignal\b\s*[:,}]/, '事件选项应接入 AbortSignal');
  assert.match(source, /addEventListener\s*\(/);
  assert.match(source, /astro:before-swap/, '清理应覆盖页面切换生命周期');
});

test('选中项和键盘焦点项仅横向进入可见区域，不滚动整个页面', () => {
  const source = read('script');
  assert.match(source, /aria-current\s*=\s*(?:\\?["'])true/);
  assert.match(source, /addEventListener\(\s*['"]focusin['"]/);
  assert.match(source, /\.getBoundingClientRect\s*\(|\.offsetLeft\b/);
  assert.match(source, /\.(?:right|offsetWidth|clientWidth)\b/);
  assert.match(source, /\.scrollBy\s*\(\s*\{[^}]*\bleft\s*[:,]/);
  assert.doesNotMatch(source, /\.scrollIntoView\s*\(|(?:window|document\.documentElement)\.scroll(?:To|By)\s*\(|\.scrollTop\s*=/,
    '不要通过滚动整页让分类项可见');
});

test('脚本尊重 reduced-motion，提供非平滑滚动分支', () => {
  const source = read('script');
  assert.match(source, /matchMedia\s*\(\s*['"]\(prefers-reduced-motion:\s*reduce\)['"]/);
  assert.match(source, /\.matches\b/);
  assert.match(source, /['"](?:auto|instant)['"]/);
  assert.match(source, /['"]smooth['"]/);
  assert.match(source, /\bbehavior\s*[:,]/);
});

test('滚动导航允许横向溢出，胶囊不收缩不换行', () => {
  const css = read('css');
  assert.match(css, /overflow-x\s*:\s*auto/);
  assert.match(css, /scrollbar-width\s*:\s*none/);
  assert.match(rules(css, /::\-webkit-scrollbar$/), /display\s*:\s*none|height\s*:\s*0(?:px)?\b/);
  const tab = rules(css, /^\.category-tab$/);
  assert.match(tab, /flex-shrink\s*:\s*0|flex\s*:\s*(?:0\s+0\s+auto|none)/);
  assert.match(tab, /white-space\s*:\s*nowrap/);
});

test('aria-current=true 胶囊提供选中背景', () => {
  assert.match(rules(read('css'), /^\.category-tab\[aria-current\s*=\s*['"]?true['"]?\]$/), /background(?:-color)?\s*:/);
});

test('移动端断点为 max-width:767px，分类触摸目标至少 44px', () => {
  const css = read('css');
  const media = /@media\s*[^{}]*\(\s*max-width\s*:\s*767px\s*\)[^{]*\{/g.exec(css);
  assert.ok(media, '缺少 max-width: 767px 移动端样式');
  const mobile = blockAfter(css, media.index + media[0].length - 1);
  assert.match(mobile, /\.category-(?:tab|tabbar)/);
  const targets = `${rules(css, /^\.category-tab$/)}\n${rules(mobile, /^\.category-tab$/)}`;
  assert.match(targets, /(?:min-height|min-block-size|height|block-size)\s*:\s*(?:4[4-9]|[5-9]\d|\d{3,})px\b|(?:min-height|min-block-size|height|block-size)\s*:\s*2\.75rem\b/,
    '分类触摸项应声明至少 44px 高度（或 2.75rem）');
});

test('暗色主题包含普通和 aria-current 选中胶囊状态', () => {
  const css = read('css');
  assert.match(rules(css, /(?:\.dark|\[data-theme=['"]dark['"]\])\s+\.category-tab$/), /color\s*:/);
  const selected = rules(css, /(?:\.dark|\[data-theme=['"]dark['"]\])\s+\.category-tab\[aria-current\s*=\s*['"]?true['"]?\]$/);
  assert.match(selected, /color\s*:/);
  assert.match(selected, /background(?:-color)?\s*:/);
});

test('分类链接与滚动按钮都提供 focus-visible 键盘焦点提示', () => {
  const css = read('css');
  const visible = /(?:outline|box-shadow)\s*:\s*(?!none\b|0(?:px)?\s*[;}])/;
  assert.match(rules(css, /^\.category-tab:focus-visible$/), visible);
  assert.match(rules(css, /(?:\.category-(?!tab:)[\w-]+|\[data-category-tabs-(?:prev|next)\]):focus-visible$/), visible,
  '滚动按钮也应有可见焦点样式');
});

