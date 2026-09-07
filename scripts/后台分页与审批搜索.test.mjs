import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
test('审批名称查询位于筛选栏，每页条数位于底部分页区', async () => {
  const page = await read('src/pages/admin/reviews.astro');
  const filters = page.match(/<form[^>]*id="review-filters"[\s\S]*?<\/form>/)?.[0];
  assert.ok(filters);
  assert.match(filters, /id="review-query"[^>]*maxlength="100"/);
  assert.doesNotMatch(filters, /review-size|每页条数|查询\s*\//);
  assert.match(filters, />查询<\/button>/);
  const pagination = page.match(/<nav class="admin-pagination"[\s\S]*?<\/nav>/)?.[0];
  assert.match(pagination, /review-size/);
  assert.match(pagination, /admin-pagination-actions/);
});
test('审批搜索使用已应用条件，翻页和改变每页条数保留名称条件', async () => {
  const script = await read('src/scripts/admin-reviews.ts');
  assert.match(script, /appliedQuery = query.value.trim\(\)/);
  assert.equal((script.match(/q: appliedQuery/g) || []).length, 2);
  assert.match(script, /size.addEventListener\('change',[\s\S]*?page = 1; void load\(\)/);
  assert.match(script, /query.value = appliedQuery = ''/);
});
test('后台已有分页列表使用同一分页操作区与每页条数文案', async () => {
  for (const name of ['sites', 'categories', 'reviews', 'announcements']) {
    const page = await read(`src/pages/admin/${name}.astro`);
    assert.match(page, /class="admin-pagination"/);
    assert.match(page, /class="admin-pagination-actions"><label>每页条数<select/);
  }
});
