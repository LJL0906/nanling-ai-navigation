import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from '@astrojs/compiler';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const { ast } = await parse(read('src/pages/search/index.astro'));
const script = read('src/scripts/search.ts');
const styles = read('src/styles/navigation-cards.css');
const personalStyles = read('src/styles/personal.css');
const favoriteTemplate = read('src/components/ui/FavoriteButton.astro');

function find(node, predicate) {
  if (predicate(node)) return node;
  return (node.children ?? []).map((child) => find(child, predicate)).find(Boolean);
}
function attribute(node, name) {
  return node?.attributes?.find((item) => item.name === name);
}
function classes(node) {
  return (attribute(node, 'class')?.value ?? '').split(/\s+/);
}
function marked(node, marker) {
  const result = find(node, (child) => Boolean(attribute(child, marker)));
  assert.ok(result, `模板缺少 ${marker}`);
  return result;
}
function rule(selector, source = styles) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = source.replace(/\/\*[\s\S]*?\*\//g, '').match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]+)\\}`))?.[1];
  assert.ok(body, `缺少样式规则 ${selector}`);
  return body;
}
const template = marked(ast, 'data-search-template');

// 从真实 Astro 模板提取属性，不在模拟 DOM 中硬编码新窗口安全约定。
test('搜索名称和快捷入口均为安全的新窗口官网链接', () => {
  const primary = marked(template, 'data-result-name');
  assert.ok(classes(primary).includes('nav-card-detail'), '名称链接应复用整卡点击区域');
  for (const marker of ['data-result-name', 'data-result-external']) {
    const link = marked(template, marker);
    assert.equal(link.name, 'a');
    assert.equal(attribute(link, 'target')?.value, '_blank');
    const rel = (attribute(link, 'rel')?.value ?? '').split(/\s+/);
    assert.ok(rel.includes('noopener'));
    assert.ok(rel.includes('noreferrer'));
  }
  const overlay = rule('.nav-card-detail::after');
  assert.match(overlay, /content\s*:/);
  assert.match(overlay, /position\s*:\s*absolute\s*;/);
  assert.match(overlay, /inset\s*:\s*0\s*;/);
});

test('搜索名称与快捷入口设置官网地址和含站名的官网无障碍标签', () => {
  for (const name of ['name', 'external']) {
    assert.match(script, new RegExp(`\\b${name}\\.href\\s*=\\s*entry\\.url\\s*;`));
    assert.match(script, new RegExp(`${name}\\.setAttribute\\(\\s*['"]aria-label['"]\\s*,\\s*\u0060[^\u0060]*\\$\\{entry\\.name\\}[^\u0060]*官网[^\u0060]*\u0060\\s*\\)`));
  }
  assert.doesNotMatch(script, /\bname\.href\s*=\s*(?:categoryPath|`\/)/,
    '名称不能退回分类路径或站内详情地址');
});

test('分类入口保留独立链接及编码后的分类路径', () => {
  const category = marked(template, 'data-result-category');
  assert.equal(category.name, 'a');
  assert.ok(classes(category).includes('nav-card-category'));
  assert.ok(!classes(category).includes('nav-card-detail'), '分类链接不能扩展覆盖整卡');
  assert.match(script, /const\s+categoryPath\s*=\s*`\/\$\{encodeURIComponent\(entry\.categorySlug\)\}\/`/);
  assert.match(script, /category\.href\s*=\s*categoryPath\s*;/);
  assert.match(script, /category\.textContent\s*=\s*entry\.categoryName\s*;/);
});

test('收藏与快捷入口独立于名称链接，保留站点绑定和上层交互', () => {
  const card = find(template, (node) => node.name === 'Card');
  assert.ok(card);
  assert.ok(card.children.some((node) => node.name === 'FavoriteButton'), '收藏必须是卡片的独立子节点');
  assert.ok(card.children.some((node) => attribute(node, 'data-result-external')));
  for (const marker of ['data-result-name', 'data-result-category', 'data-result-external']) {
    assert.equal(find(marked(template, marker), (node) => node.name === 'FavoriteButton' || node.name === 'button'), undefined);
  }
  assert.match(favoriteTemplate, /<button\b[^>]*type="button"[^>]*data-favorite-id=/);
  assert.match(script, /favorite\.dataset\.favoriteId\s*=\s*entry\.id\s*;/);
  assert.match(script, /favorite\.dataset\.siteName\s*=\s*entry\.name\s*;/);
  assert.match(rule('.nav-card > .favorite-button', personalStyles), /z-index\s*:\s*[1-9]\d*\s*;/);
  assert.match(rule('.nav-card .nav-card-external'), /z-index\s*:\s*[1-9]\d*\s*;/);
});

test('搜索卡片使用独立样式，分类标签位于整卡链接上层', () => {
  const card = find(template, (node) => node.name === 'Card');
  assert.ok(classes(card).includes('nav-card--search'));
  const category = rule('.nav-card--search .nav-card-category');
  assert.match(category, /position\s*:\s*relative\s*;/);
  assert.match(category, /z-index\s*:\s*1\s*;/);
  // 只验证三行信息各自有搜索专属字号，不锁定像素、行高或间距。
  for (const selector of [
    '.nav-card--search .nav-card-copy > :first-child',
    '.nav-card--search .nav-card-copy > :nth-child(2)',
    '.nav-card--search .nav-card-category',
  ]) assert.match(rule(selector), /font-size\s*:\s*[^;]+;/);
});

