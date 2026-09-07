import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { paginateCategory } from '../src/lib/category-facets.ts';

const category = { name: '测试分类', slug: 'test', sites: Array.from({ length: 125 }, (_, i) => ({
  id: 'stable-' + i, slug: 'new-' + i, tags: i < 110 ? ['可编辑标签'] : [], sourceCategories: [],
})) };
for (const requested of [null, 'all', 'missing']) {
  test('无参数、全部或失效细分默认展示完整分页：' + requested, () => {
    const state = paginateCategory(category, requested, 2, 48);
    assert.equal(state.selected.key, 'all');
    assert.equal(state.total, 125);
    assert.equal(state.totalPages, 3);
    assert.equal(state.sites[0].id, 'stable-48');
    assert.equal(state.sites.length, 48);
  });
}
test('细分先筛选后分页，末页完整且没有重复遗漏', () => {
  const pages = [1, 2, 3].map(page => paginateCategory(category, 'label:可编辑标签', page, 48));
  assert.deepEqual(pages.map(page => page.sites.length), [48, 48, 14]);
  assert.equal(new Set(pages.flatMap(page => page.sites.map(site => site.id))).size, 110);
  assert.equal(paginateCategory(category, 'label:可编辑标签', 99, 48).page, 3);
});
test('分类SSR输出真实筛选结果与带细分参数的分页，浏览器不再隐藏分页', () => {
  const template = readFileSync(new URL('../src/components/category/CategoryPage.astro', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../src/scripts/category.ts', import.meta.url), 'utf8');
  assert.ok(template.includes("paginateCategory(category, Astro.url.searchParams.get('sub')"));
  assert.match(template, /pageSites.map/);
  assert.ok(template.includes('pageHref(1, tab.key)'));
  assert.ok(template.includes('encodeURIComponent(key)'));
  assert.doesNotMatch(template + script, /siteSlugs|defaultSlugs|pagination.hidden/);
});

test('分类卡片主体直接打开官网，整卡链接不包裹收藏按钮', () => {
  const template = readFileSync(new URL('../src/components/category/CategoryPage.astro', import.meta.url), 'utf8');
  const link = template.match(/<a\b[^>]*class="category-site-link[^>]*>/)?.[0];
  assert.ok(link, '站点名称应使用整卡官网链接');
  assert.ok(link.includes('href={site.url}'));
  assert.ok(link.includes('target="_blank"'));
  assert.ok(link.includes('rel="noopener noreferrer"'));
  assert.match(template, /\.category-site-link::after\s*\{[^}]*position: absolute;[^}]*inset: 0;[^}]*z-index: 1;/);
  assert.match(template, /\.category-site-link:focus-visible::after/);
  assert.match(template, /\.nav-card-external\s*\{ z-index: 2;/);
  assert.match(template, /<Card siteId=\{site.id\} class=/);
  assert.match(template, /<\/a>\s*<\/div>\s*<FavoriteButton siteId=\{site.id\}/);
  assert.ok(!template.includes('href={`/${category.slug}/${site.slug}/`}'));
  const personalCss = readFileSync(new URL('../src/styles/personal.css', import.meta.url), 'utf8');
  assert.match(personalCss, /\.nav-card > \.favorite-button\s*\{[^}]*z-index: 2;/);
});
