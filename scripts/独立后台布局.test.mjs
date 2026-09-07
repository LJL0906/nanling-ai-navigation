import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = path => readFile(new URL('../' + path, import.meta.url), 'utf8');
test('后台页面统一使用独立布局，不嵌入前台组件', async () => {
  const layout = await source('src/layouts/AdminLayout.astro');
  assert.match(layout, /<!doctype html>/);
  assert.match(layout, /admin-sidebar/);
  assert.match(layout, /admin-topbar/);
  assert.match(layout, /admin-content/);
  assert.doesNotMatch(layout, /BaseLayout|ClientRouter|SiteSubmission|GlobalBackground|global\.css|scripts\/main/);
  for (const page of ['sites', 'categories', 'menus', 'reviews', 'login']) {
    const text = await source(`src/pages/admin/${page}.astro`);
    assert.match(text, /AdminLayout/);
    assert.doesNotMatch(text, /BaseLayout/);
  }
  for (const path of ['/admin/sites/', '/admin/categories/', '/admin/menus/', '/admin/reviews/']) assert.ok(layout.includes(path));
});
test('登录不展示管理壳，管理页只有统一账号退出入口', async () => {
  const login = await source('src/pages/admin/login.astro');
  assert.match(login, /<AdminLayout[^>]+guest/);
  const layout = await source('src/layouts/AdminLayout.astro');
  assert.match(layout, /guest \? <slot/);
  assert.match(layout, /data-shell-logout/);
  const css = await source('src/styles/admin.css');
  assert.match(css, /#menu-logout,#review-logout,#review-account,\[data-admin-logout\]/);
  assert.match(css, /max-width:900px/);
  assert.match(css, /visibility:hidden/);
});
test('导航卡片移至独立页面且保留筛选分页', async () => {
  const sites = await source('src/pages/admin/sites.astro');
  for (const key of ['root', 'filter', 'query', 'category', 'sites', 'prev', 'next']) assert.ok(sites.includes('data-admin-' + key));
  const overview = await source('src/pages/admin/index.astro');
  assert.match(overview, /Astro.redirect\('\/admin\/sites\/', 302\)/);
  assert.doesNotMatch(overview, /data-admin-filter/);
});

test('统一退出入口跟随页面退出按钮的忙碌状态', async () => {
  const shell = await source('src/scripts/admin-shell.ts');
  assert.match(shell, /logout.disabled = localLogout.disabled/);
  assert.match(shell, /new MutationObserver\(syncLogout\)/);
  assert.match(shell, /attributeFilter: \['disabled'\]/);
});

test('管理内容页仅保留操作区域，不输出大标题或常驻介绍', async () => {
  for (const name of ['sites', 'categories', 'menus', 'reviews', 'announcements']) {
    const page = await source(`src/pages/admin/${name}.astro`);
    assert.doesNotMatch(page, /<h1\b|class="admin-page-heading"|class="intro"|class="boundary"/);
  }
  assert.doesNotMatch(await source('src/layouts/AdminLayout.astro'), /<footer/);
});
