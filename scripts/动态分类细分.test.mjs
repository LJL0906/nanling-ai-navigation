import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCategoryFacets, paginateCategory } from '../src/lib/category-facets.ts';
import { buildHomeSection } from '../src/lib/home-sections.ts';
const site = (id, tags = [], sourceCategories = []) => ({ id, slug: id, tags, sourceCategories });
const category = sites => ({ slug: 'new-category', name: '新分类', sites });

test('新分类和新站点无需代码规则，后台标签立即生成归属', () => {
  const current = category([site('new-db-id', ['新业务标签']), site('other-id')]);
  assert.deepEqual(buildHomeSection(current).tabs, buildCategoryFacets(current));
  assert.deepEqual(buildCategoryFacets(current).find(tab => tab.key === 'label:新业务标签').indices, [0]);
  current.sites[1].tags = ['新业务标签'];
  assert.deepEqual(buildCategoryFacets(current).find(tab => tab.key === 'label:新业务标签').indices, [0, 1]);
});
test('拆分来源层级、合并重复标签、排除一级分类且保留多重归属', () => {
  const tabs = buildCategoryFacets(category([site('a', [' API ', 'ＡＰＩ'], ['新分类 | API', '工具 > 图像'])]));
  assert.equal(tabs.filter(tab => tab.key === 'label:api').length, 1);
  assert.deepEqual(tabs.find(tab => tab.key === 'label:api').indices, [0]);
  assert.ok(tabs.some(tab => tab.label === '图像'));
  assert.ok(!tabs.some(tab => tab.label === '新分类' || tab.label.includes('|')));
});
test('标签键稳定，不受站点重排影响，不与全部和未细分保留键冲突', () => {
  const a = site('a', ['all', '未细分', '<script>']);
  const b = site('b', ['新标签']);
  const keys = sites => buildCategoryFacets(category(sites)).map(tab => tab.key).sort();
  assert.deepEqual(keys([a, b]), keys([b, a]));
  assert.ok(keys([a]).includes('label:all'));
});
test('空分类、无细分和无效分页参数可安全回退', () => {
  assert.deepEqual(buildCategoryFacets(category([])), [{ key: 'all', label: '全部', indices: [] }]);
  const current = category([site('a', [], ['新分类']), site('b')]);
  assert.deepEqual(buildCategoryFacets(current)[1].indices, [0, 1]);
  assert.equal(paginateCategory(current, null, NaN, 48).page, 1);
  assert.throws(() => paginateCategory(current, null, 1, 0));
});
test('原始站点与稳定ID不会被动态细分修改', () => {
  const current = category([site('stable-id', ['标签'], ['父类 | 子类'])]);
  const before = structuredClone(current);
  buildCategoryFacets(current);
  paginateCategory(current, 'label:标签', 1, 48);
  assert.deepEqual(current, before);
});

test('内部追踪标签不展示，真正用途与 HTTP 开发分类保留', () => {
  const current = category([
    site('a', ['包含HTTP来源', '项目原始精选', '多来源合并', 'AI写作'], ['HTTP来源 | API工具']),
    site('b', [' 包含 ＨＴＴＰ 来源 ', '项目原始精选'], ['多来源合并']),
    site('c', ['HTTP调试', '来源分析', '精选素材', '数据合并工具']),
  ]);
  const tabs = buildCategoryFacets(current);
  const labels = tabs.map(tab => tab.label);
  for (const label of ['包含HTTP来源', 'HTTP来源', '项目原始精选', '多来源合并']) {
    assert.ok(!labels.includes(label));
  }
  for (const label of ['AI写作', 'API工具', 'HTTP调试', '来源分析', '精选素材', '数据合并工具']) {
    assert.ok(labels.includes(label));
  }
  assert.deepEqual(tabs[0].indices, [0, 1, 2]);
  assert.deepEqual(tabs.find(tab => tab.key === 'unclassified').indices, [1]);
});

test('首页分区和标签容器可收缩，横向溢出仅在标签栏内部滚动', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../src/styles/home-navigation.css', import.meta.url), 'utf8');
  const blocks = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const selector of ['.home-navigation', '.home-section', '.home-section-tabbar', '.home-section-tabs']) {
    const declarations = blocks.filter(([, selectors]) => selectors.split(',').some(value => value.trim() === selector))
      .map(([, , body]) => body).join(';');
    assert.match(declarations, /min-width:\s*0\s*;/, selector);
    assert.match(declarations, /max-width:\s*100%\s*;/, selector);
  }
  assert.match(css, /\.home-section-tabs\s*\{[^}]*overflow-x:\s*auto/);
});
