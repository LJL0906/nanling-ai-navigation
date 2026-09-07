import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { adminPageNumbers } from '../src/scripts/admin-pagination.ts';

test('少量页码连续展示，空数据视为一页', () => {
  assert.deepEqual(adminPageNumbers(1, 0), [1]);
  assert.deepEqual(adminPageNumbers(2, 5), [1, 2, 3, 4, 5]);
});
test('大列表保留首尾及当前页窗口，不生成成千上万个按钮', () => {
  assert.deepEqual(adminPageNumbers(1, 120), [1, 2, 3, 4, 5, 6, 'ellipsis', 120]);
  assert.deepEqual(adminPageNumbers(60, 120), [1, 'ellipsis', 58, 59, 60, 61, 62, 'ellipsis', 120]);
  assert.deepEqual(adminPageNumbers(120, 120), [1, 'ellipsis', 115, 116, 117, 118, 119, 120]);
  for (let page = 1; page <= 120; page++) {
    const buttons = adminPageNumbers(page, 120).filter(value => typeof value === 'number');
    assert.ok(buttons.includes(page));
    assert.equal(new Set(buttons).size, buttons.length);
    assert.ok(buttons.length <= 7);
  }
});
test('所有模块共享分页交互，统一限制查询宽度与行高', async () => {
  for (const name of ['admin', 'admin-reviews', 'admin-menus', 'admin-announcements']) {
    const source = await readFile(new URL(`../src/scripts/${name}.ts`, import.meta.url), 'utf8');
    assert.match(source, /bindAdminPagination/);
  }
  const css = await readFile(new URL('../src/styles/admin-content.css', import.meta.url), 'utf8');
  assert.match(css, /\.admin-app \.admin-content\{max-width:none;padding:0;margin:0\}/);
  assert.match(css, /flex:0 1 200px/);
  assert.match(css, /height:44px/);
  assert.match(css, /\.admin-app \.admin-pagination\{[^}]*justify-content:flex-end/);
});
