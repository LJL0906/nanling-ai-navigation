import { isValidSiteId } from '../src/lib/site-id.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { adaptNavigation } from '../src/lib/adapt-navigation.ts';
import { isBrandIcon } from '../src/lib/brand-icon.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const page = read('src/pages/search/index.astro');
const script = read('src/scripts/search.ts');
const executable = stripTypeScriptTypes(script)
  .replace(/^import .*;\r?\n/gm, '')
  .replace(/^export /gm, '');
const localImage = `/site-icons/${'a'.repeat(64)}.png`;
const { categories } = adaptNavigation(JSON.parse(read('src/data/导航数据.json')), JSON.parse(read('src/data/sites.json')));
// 执行页面实际的模板名称表达式，防止测试复制筛选逻辑而漏掉页面回归。
const iconExpression = page.match(/const brandIcons = (.+);/)[1];
const brandNames = runInNewContext(iconExpression, { categories, isBrandIcon });

function element() {
  return {
    style: {}, dataset: {}, textContent: '',
    classList: { add() {}, toggle() {} },
    setAttribute() {}, addEventListener() {},
  };
}
function svg(name) {
  return {
    ...element(), name, tagName: 'svg', children: [{ tagName: 'path', d: 'M0 0h18v18z' }],
    cloneNode(deep) {
      assert.equal(deep, true);
      const copy = svg(name);
      copy.style = { ...this.style };
      copy.children = this.children.map((child) => ({ ...child }));
      return copy;
    },
  };
}
function iconContainer() {
  const fallback = element();
  return {
    ...element(), className: 'search-result-icon nav-card-icon', children: [fallback],
    querySelector(selector) { assert.equal(selector, 'span'); return fallback; },
    replaceChildren(...children) { this.children = children; },
  };
}
function brandTemplate(name) {
  const glyph = svg(name);
  return {
    dataset: { searchBrandIcon: name },
    content: { querySelector(selector) { assert.equal(selector, 'svg'); return glyph; } },
  };
}
function runtime(root = null, sites = []) {
  const imageCalls = [];
  const templates = new Map(brandNames.map((name) => [name, brandTemplate(name)]));
  const requests = [];
  const context = {
    isValidSiteId, URL, URLSearchParams, AbortController, setTimeout, clearTimeout,
    location: new URL('https://navigation.invalid/search/'),
    history: { state: {}, replaceState() {} },
    document: {
      querySelector(selector) { assert.equal(selector, '[data-search-root]'); return root; },
      addEventListener() {},
      createDocumentFragment() { return { children: [], append(card) { this.children.push(card); } }; },
    },
    window: { addEventListener() {} },
    appendSiteImage(icon, value) { imageCalls.push({ icon, value }); },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ version: 1, categories: [{ slug: 'tools', name: '工具' }], sites }) };
    },
  };
  runInNewContext(`${executable}\nglobalThis.appendBrand = appendSearchBrandIcon;`, context);
  return { appendBrand: context.appendBrand, templates, imageCalls, requests };
}

test('搜索模板覆盖28个品牌站点并去重为27个，仅接受本地有效Iconify名称', () => {
  const brandSites = categories.flatMap((category) => category.sites).filter((site) => isBrandIcon(site.icon));
  assert.equal(brandSites.length, 28);
  assert.equal(brandNames.length, 27);
  for (const site of brandSites) assert.ok(brandNames.includes(site.icon));
  const mixed = [{ sites: [
    { icon: 'simple-icons:github' }, { icon: 'simple-icons:github' }, { icon: 'lucide:search' },
    ...[localImage, 'https://evil.invalid/icon.svg', '//evil.invalid/a', 'simple-icons:does-not-exist',
      'unknown:github', '<svg onload=alert(1)>', null, {}].map((icon) => ({ icon })),
  ] }];
  assert.deepEqual(Array.from(runInNewContext(iconExpression, { categories: mixed, isBrandIcon })),
    ['simple-icons:github', 'lucide:search']);
});

test('品牌模板只提供自包含内联glyph，不创建图片模板或客户端图标库依赖', () => {
  const markup = page.match(/<template data-search-brand-icon=\{icon\}>([\s\S]*?)<\/template>/)[1];
  assert.match(markup, /<Icon name=\{icon\} is:inline style="width:18px;height:18px"\s*\/>/);
  assert.doesNotMatch(markup, /<img|<BrandIcon|<span|<use\b/);
  assert.doesNotMatch(script, /(?:import|fetch).*?(?:@iconify|brand-icon|https?:\/\/)/);
  assert.match(script, /if \(!appendSearchBrandIcon\(icon, entry\.icon, brandIcons, color\)\) appendSiteImage\(icon, entry\.icon\)/);
});

test('全部品牌glyph深克隆进原容器，颜色独立且模板不被修改', () => {
  const { appendBrand, templates } = runtime();
  for (const name of brandNames) {
    const first = iconContainer();
    const second = iconContainer();
    first.style.backgroundColor = '#1234561f';
    assert.equal(appendBrand(first, name, templates, '#123456'), true);
    assert.equal(appendBrand(second, name, templates, '#abcdef'), true);
    assert.equal(first.className, 'search-result-icon nav-card-icon');
    assert.equal(first.style.backgroundColor, '#1234561f');
    assert.equal(first.children.length, 1);
    assert.equal(first.children[0].style.color, '#123456');
    assert.equal(second.children[0].style.color, '#abcdef');
    const source = templates.get(name).content.querySelector('svg');
    assert.notEqual(first.children[0], source);
    assert.notEqual(first.children[0], second.children[0]);
    assert.notEqual(first.children[0].children[0], source.children[0]);
    assert.equal(source.style.color, undefined);
  }
});

test('图片、未知品牌、外站及损坏模板不替换首字，也不触发额外请求', () => {
  const { appendBrand, templates, requests } = runtime();
  templates.set('broken', { content: { querySelector: () => null } });
  for (const value of [localImage, null, {}, 'broken', 'simple-icons:does-not-exist',
    'https://evil.invalid/icon.svg', '//evil.invalid/a', '<svg onload=alert(1)>']) {
    const icon = iconContainer();
    const fallback = icon.children[0];
    assert.equal(appendBrand(icon, value, templates, '#123456'), false);
    assert.equal(icon.children[0], fallback);
  }
  assert.deepEqual(requests, []);
});

test('实际搜索渲染优先品牌SVG，非法颜色回退，非品牌继续交给原图片逻辑', async () => {
  const icons = [...brandNames, localImage, null, 'https://evil.invalid/icon.svg', 'simple-icons:does-not-exist'];
  const sites = icons.map((icon, i) => ({
    id: `site_${i}`, url: `https://example.invalid/${i}`, slug: `site-${i}`, name: `站点${i}`,
    desc: '测试', color: i === 1 ? 'red;url(https://evil.invalid)' : '#123456',
    icon, mono: '站', category: 0, terms: '',
  }));
  const nodes = new Map();
  const cards = [];
  const list = { ...element(), replaceChildren(fragment) { this.children = fragment?.children ?? []; } };
  nodes.set('[data-search-list]', list);
  nodes.set('[data-search-input]', { ...element(), value: '' });
  nodes.set('[data-search-template]', { content: { cloneNode(deep) {
    assert.equal(deep, true);
    const icon = iconContainer();
    const card = { icon, querySelector(selector) { return selector === '.search-result-icon' ? icon : element(); } };
    cards.push(card);
    return card;
  } } });
  const root = {
    isConnected: true,
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, element());
      return nodes.get(selector);
    },
    querySelectorAll(selector) {
      assert.equal(selector, 'template[data-search-brand-icon]');
      return brandNames.map(brandTemplate);
    },
  };
  const { requests, imageCalls } = runtime(root, sites);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(list.children.length, sites.length);
  assert.equal(cards[0].icon.children[0].tagName, 'svg');
  assert.equal(cards[0].icon.children[0].style.color, '#123456');
  assert.equal(cards[1].icon.children[0].style.color, '#3777f5');
  assert.equal(cards[1].icon.style.backgroundColor, '#3777f51f');
  assert.deepEqual(imageCalls.map(({ value }) => value), icons.slice(brandNames.length));
  assert.equal(cards.at(-1).icon.children[0].textContent, '站');
  assert.deepEqual(requests.map(({ url }) => url), ['/search-index.json']);
  assert.equal(requests[0].options.mode, 'same-origin');
});
