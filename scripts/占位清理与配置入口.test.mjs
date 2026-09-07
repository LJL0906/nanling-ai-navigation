import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
test('删除两个占位路由及不再使用的占位组件', () => {
  for (const file of ['src/pages/articles/index.astro', 'src/pages/quick-search/index.astro', 'src/components/layout/ComingSoon.astro']) {
    assert.equal(existsSync(new URL('../' + file, import.meta.url)), false, file);
  }
});
test('标签目录复用真实细分并跳转服务端sub参数', () => {
  const source = read('src/pages/tags/index.astro');
  assert.match(source, /buildCategoryFacets\(category\)/);
  assert.match(source, /\?sub=\$\{encodeURIComponent\(key\)\}/);
  assert.match(source, /facet\.indices\.length/);
  assert.doesNotMatch(source, /site\.name/);
});
test('全站配置后台入口、字段、版本提交与草稿保护接线', () => {
  assert.match(read('src/layouts/AdminLayout.astro'), /href: '\/admin\/settings\/'/);
  const page = read('src/pages/admin/settings.astro');
  assert.match(page, /data-settings-fields disabled/);
  assert.match(page, /name="homeSectionPageSize"/);
  const script = read('src/scripts/admin-settings.ts');
  assert.match(script, /\/api\/admin\/settings/);
  assert.match(script, /method: 'PUT'/);
  assert.match(script, /revision: snapshot\.revision/);
  assert.match(script, /window\.confirm/);
  assert.match(script, /beforeunload/);
});
