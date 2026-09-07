import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

const emptyCases = [
  { name: '站点与分类', file: 'admin', condition: /if\s*\(!filtered\.length\)\s*\{([^}]+)\}/, variable: 'td' },
  { name: '菜单', file: 'admin-menus', condition: /if\s*\(!count\)\s*\{([^}]+)\}/, variable: 'cell' },
  { name: '公告', file: 'admin-announcements', condition: /if\s*\(!items\.length\)\s*\{([^}]+)\}/, variable: 'td' },
  { name: '审批', file: 'admin-reviews', condition: /if\s*\(!data\.items\.length\)\s*\{([^}]+)\}/, variable: 'cell' },
];

for (const { name, file, condition, variable } of emptyCases) {
  test(`${name}表格空数据使用 content-empty 单元格并显示“无数据”`, async () => {
    const source = await read(`../src/scripts/${file}.ts`);
    const match = source.match(condition);
    assert.ok(match, `${file} 应保留空数据分支`);
    const block = match[1];
    assert.match(block, new RegExp(`${variable}\\.className\\s*=\\s*['"]content-empty['"]`));

    if (file === 'admin') {
      assert.match(block, /const\s+td\s*=\s*cell\(row,\s*loading\s*\?\s*['"]正在加载…['"]\s*:\s*['"]无数据['"]\)/);
      assert.match(source, /function\s+cell\([^)]*\)\s*\{\s*const\s+td\s*=\s*document\.createElement\(['"]td['"]\)/);
    } else if (file === 'admin-announcements') {
      assert.match(block, /const\s+td\s*=\s*node\(['"]td['"],\s*['"]无数据['"]\)/);
    } else {
      assert.match(block, /cell\s*=\s*document\.createElement\(['"]td['"]\)/);
      assert.match(block, /cell\.textContent\s*=\s*['"]无数据['"]/);
    }

    assert.match(block, new RegExp(`row\\.append\\(${variable}\\)|cell\\(row,`));
    assert.match(block, /(?:rows|list)\.append\(row\)/);
    if (file === 'admin-reviews') assert.match(block, /cell\.colSpan\s*=\s*8\s*;/);
  });
}

test('审批加载成功只通知显式成功文案，不再显示旧空数据提示', async () => {
  const source = await read('../src/scripts/admin-reviews.ts');
  assert.doesNotMatch(source, /当前筛选下暂无提交记录。/);
  assert.match(source, /notify\(\s*success\s*\?\?\s*(['"])\1\s*\)/);
});

test('空状态使用表格单元格 height 240px 作为最小高度，不回退为 100px', async () => {
  const css = await read('../src/styles/admin-content.css');
  const rules = [...css.matchAll(/\.content-empty\s*\{([^}]+)\}/g)];
  assert.ok(rules.length > 0, '应定义 .content-empty 样式');
  for (const [, declarations] of rules) {
    assert.match(declarations, /(?:^|;)\s*height\s*:\s*240px\s*(?:!important\s*)?(?:;|$)/);
    assert.doesNotMatch(declarations, /(?:^|;)\s*(?:min-|max-)?height\s*:\s*100px\b/);
    // 表格单元格的 height 可随内容撑开，不应用 min-height 替代。
    assert.doesNotMatch(declarations, /(?:^|;)\s*min-height\s*:/);
    assert.doesNotMatch(declarations, /(?:^|;)\s*display\s*:\s*(?:block|flex|grid|inline-block)\b/);
  }
});
