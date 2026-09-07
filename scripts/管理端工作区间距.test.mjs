import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('管理端工作区取消居中限宽和各断点外层留白', async () => {
  const base = await read('../src/styles/admin.css');
  const content = await read('../src/styles/admin-content.css');
  assert.match(base, /\.admin-content\{padding:0;[^}]*max-width:none;margin:0\}/);
  for (const css of [base, content]) {
    for (const [, declarations] of css.matchAll(/\.admin-content\{([^}]+)\}/g)) {
      assert.doesNotMatch(declarations, /padding:(?!0(?:;|$))/);
      assert.doesNotMatch(declarations, /max-width:\d/);
    }
  }
  assert.match(content, /\.admin-panel\{[^}]*margin-bottom:0/);
});

test('菜单空状态条不占位，加载与错误重试状态保留', async () => {
  const css = await read('../src/styles/admin-content.css');
  assert.match(css, /\.status-row:has\(#menu-status:empty\):has\(#menu-loading\[hidden\]\):has\(#menu-retry\[hidden\]\)\{display:none\}/);
  assert.match(css, /#menu-workspace>\.panel:first-child\{margin-top:0\}/);
});
