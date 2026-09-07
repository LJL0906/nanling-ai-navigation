import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { adaptNavigation } from '../src/lib/adapt-navigation.ts';
import { buildHomeSection } from '../src/lib/home-sections.ts';
import { buildCategoryFacets } from '../src/lib/category-facets.ts';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const { categories } = adaptNavigation(read('../src/data/导航数据.json'), read('../src/data/sites.json'));
const sections = categories.map((category) => buildHomeSection(category));

test('首页18个独立分区的全部Tab覆盖2400条站点，不截断数据', () => {
  assert.equal(sections.length, 18);
  assert.equal(sections.reduce((n, section) => n + section.sites.length, 0), 2400);
  for (const section of sections) {
    assert.deepEqual(section.tabs[0].indices, section.sites.map((_, i) => i));
    assert.ok(section.sites.every((site) => site.categorySlug === section.slug));
  }
});
test('每个分区Tab主键唯一，无空Tab或越界记录，所有内容可回到全部', () => {
  for (const section of sections) {
    assert.equal(new Set(section.tabs.map((tab) => tab.key)).size, section.tabs.length);
    for (const tab of section.tabs) {
      assert.ok(tab.indices.length > 0);
      assert.equal(new Set(tab.indices).size, tab.indices.length);
      assert.ok(tab.indices.every((index) => index >= 0 && index < section.sites.length));
    }
    if (section.tabs.length > 1) {
      assert.equal(new Set(section.tabs.slice(1).flatMap((tab) => tab.indices)).size, section.sites.length);
    }
  }
});
test('首页与分类页从同一快照生成完全相同的动态细分', () => {
  categories.forEach((category, index) => assert.deepEqual(sections[index].tabs, buildCategoryFacets(category)));
  const ai = sections.find(section => section.slug === 'ai');
  assert.ok(ai.tabs.some(tab => tab.label.includes('聊天') && tab.indices.length > 2));
});
test('首页 SSR 使用运行时数量，种子默认18张，复用 categories 并保留无JS入口', () => {
  const template = readFileSync(new URL('../src/components/home/HomeNavigation.astro', import.meta.url), 'utf8');
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  assert.match(template, /category\.sites\.slice\(0, pageSize\)\.map/);
  assert.match(template, /homeSectionPageSize: pageSize/);
  assert.match(template, /data-home-page-size=\{pageSize\}/);
  assert.match(template, /data-home-more hidden/);
  assert.match(template, /<noscript>.*全部.*完整分类/);
  assert.match(template, /class="home-section-all" href=\{`\/\$\{category.slug\}\/`\}/);
  assert.doesNotMatch(template, /getNavigation/);
  assert.match(page, /<HomeNavigation categories=\{categories\} \/>/);
  assert.equal(categories.reduce((count, category) => count + Math.min(18, category.sites.length), 0), 299);
});
test('影视分类站点按实际来源标签进入动态细分', () => {
  const category = categories.find(category => category.slug === 'media');
  const section = sections.find(section => section.slug === 'media');
  const index = section.sites.findIndex(site => site.name === '硬核影视');
  assert.ok(index >= 0);
  assert.ok(category.sites[index].sourceCategories.length);
  assert.ok(section.tabs.slice(1).some(tab => tab.indices.includes(index)));
});
test('展示模型保留详情及官网两种路径需要的字段，不下发来源对象', () => {
  for (const section of sections) {
    for (const site of section.sites) {
      assert.ok(site.slug && site.categorySlug && site.name);
      assert.match(site.url, /^https?:\/\//);
      assert.ok(!('sources' in site));
    }
  }
});
