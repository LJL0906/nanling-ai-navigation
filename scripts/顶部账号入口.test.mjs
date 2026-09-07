import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

test('未登录下拉提供登录入口，真实会话控制显示，外层账号弹窗保留', async () => {
  const [topbar, status, script] = await Promise.all([
    read('../src/components/layout/Topbar.astro'),
    read('../src/components/layout/AccountStatus.astro'),
    read('../src/scripts/account-status.ts'),
  ]);
  assert.match(topbar, /data-account-open="login" data-account-menu-login/);
  assert.match(script, /data-account-menu-login/);
  assert.match(script, /node.hidden = !!username/);
  assert.match(topbar, /<AccountStatus\s*\/>/);
  assert.match(topbar, /children\(item\)\.map/);
  assert.match(status, /<button[^>]*data-account-open="login"/);
  assert.match(status, /<button[^>]*data-account-open="register"/);
});

test('设置仍进入独立管理员登录页，不进入普通用户注册流程', async () => {
  const settings = await read('../src/pages/settings/index.astro');
  assert.match(settings, /Astro.redirect\("\/admin\/login\/", 302\)/);
});
