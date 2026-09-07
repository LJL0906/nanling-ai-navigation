import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildMenuSeed } from '../src/server/menu-seed.ts';
import { getSidebarMain, SIDEBAR_SHORTCUTS } from '../src/config/nav.ts';
import { SITE, CURRENT_USER } from '../src/config/site.ts';
import { RESOURCE_GROUPS } from '../src/data/curated-resources.ts';
import { adaptNavigation } from '../src/lib/adapt-navigation.ts';
import { HOME_SECTION_PAGE_SIZE } from '../src/lib/home-sections.ts';
import raw from '../src/data/导航数据.json' with { type: 'json' };
import legacy from '../src/data/sites.json' with { type: 'json' };

const readSource = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const children = (menus, location, parentId = null) => menus
  .filter((item) => item.location === location && item.parentId === parentId)
  .sort((a, b) => a.sortOrder - b.sortOrder);

function assertJson(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') return assert.ok(Number.isFinite(value));
  assert.equal(typeof value, 'object');
  assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
  for (const entry of Object.values(value)) assertJson(entry);
}

test('同步无参构建，全部字段严格 JSON 可序列化且构建结果隔离', () => {
  assert.equal(buildMenuSeed.length, 0);
  const seed = buildMenuSeed();
  assert.deepEqual(Object.keys(seed).sort(), ['menus', 'settings']);
  assert.ok(Array.isArray(seed.menus) && Array.isArray(seed.settings));
  assertJson(seed);
  assert.deepEqual(JSON.parse(JSON.stringify(seed)), seed);
  assert.deepEqual(buildMenuSeed(), seed);
  const pristine = buildMenuSeed();
  seed.menus[0].payload.menuId = 'changed';
  seed.menus.find((item) => item.kind === 'resource').payload.name = 'changed';
  seed.settings.find((item) => item.key === 'legacySites').value.categories[0].sites.pop();
  seed.settings.find((item) => item.key === 'resourceGroups').value[0].resources[0].name = 'changed';
  seed.settings.find((item) => item.key === 'site').value.name = 'changed';
  assert.deepEqual(buildMenuSeed(), pristine);
});

test('菜单完整字段、唯一 ID、有效无环父子关系和连续同级排序', () => {
  const { menus, settings } = buildMenuSeed();
  const byId = new Map(menus.map((item) => [item.id, item]));
  assert.equal(byId.size, menus.length);
  assert.equal(new Set(settings.map((item) => item.key)).size, settings.length);
  const siblingGroups = new Map();
  const inserted = new Set();
  for (const item of menus) {
    assert.deepEqual(Object.keys(item).sort(), [
      'id', 'parentId', 'location', 'kind', 'label', 'href', 'icon', 'sortOrder', 'enabled', 'payload',
    ].sort());
    for (const key of ['id', 'location', 'kind', 'label']) assert.ok(typeof item[key] === 'string' && item[key]);
    for (const key of ['parentId', 'href', 'icon']) assert.ok(item[key] === null || typeof item[key] === 'string');
    assert.match(item.id, /^[\x20-\x7e]{1,191}$/);
    assert.ok(item.location.length <= 32 && item.kind.length <= 32);
    if (item.parentId !== null) assert.ok(inserted.has(item.parentId), '自引用 FK 要求父项先于子项');
    inserted.add(item.id);
    assert.equal(item.enabled, true);
    assert.ok(Number.isInteger(item.sortOrder) && item.sortOrder >= 0);
    assert.equal(Object.getPrototypeOf(item.payload), Object.prototype);
    assert.equal(item.href === null, item.kind === 'group');
    if (item.href !== null) assert.match(item.href, /^(?:\/(?!\/)|https?:\/\/)/);
    const seen = new Set([item.id]);
    let current = item;
    while (current.parentId !== null) {
      const parent = byId.get(current.parentId);
      assert.ok(parent, `不存在的父节点：${current.parentId}`);
      assert.equal(parent.location, item.location);
      assert.equal(parent.kind, 'group');
      assert.ok(!seen.has(parent.id), '父子关系存在环');
      seen.add(parent.id);
      current = parent;
    }
    const key = JSON.stringify([item.location, item.parentId]);
    const siblings = siblingGroups.get(key) ?? [];
    siblings.push(item.sortOrder);
    siblingGroups.set(key, siblings);
  }
  for (const orders of siblingGroups.values()) {
    assert.deepEqual(orders.sort((a, b) => a - b), orders.map((_, i) => i));
  }
  for (const setting of settings) {
    assert.deepEqual(Object.keys(setting).sort(), ['key', 'value']);
    assert.match(setting.key, /^[\x20-\x7e]{1,191}$/);
  }
});

test('侧栏覆盖当前全部分类、首页和更多分类，保留锚点与原路径，不启用快捷栏', () => {
  const { menus } = buildMenuSeed();
  const { categories } = adaptNavigation(raw, legacy, {});
  assert.equal(categories.length, raw.categories.length);
  const expected = getSidebarMain(categories);
  const actual = children(menus, 'sidebar');
  assert.equal(actual.length, categories.length + 2);
  assert.deepEqual(actual.map((item) => item.label), expected.map((item) => item.label));
  expected.forEach((item, i) => {
    const anchor = item.href !== '/' && item.href !== '/categories/' ? item.href.split('/')[1] : null;
    assert.equal(actual[i].href, anchor ? `/#${anchor}` : item.href);
    assert.equal(actual[i].icon, item.icon);
    assert.equal(actual[i].payload.menuId, item.href);
    if (anchor) {
      assert.equal(actual[i].payload.categoryPath, item.href);
      assert.equal(actual[i].payload.homeAnchor, anchor);
    }
  });
  assert.ok(!menus.some((item) => item.location.startsWith('sidebar')
    && SIDEBAR_SHORTCUTS.some((shortcut) => shortcut.href === item.href)));
  assert.deepEqual(children(menus, 'sidebar-footer').map((item) => [item.label, item.href, item.icon]),
    [['设置', '/settings/', 'lucide:settings']]);
});

test('顶部首页、精选分组、每个完整资源、查看全部和收藏严格对齐当前来源', () => {
  const { menus } = buildMenuSeed();
  const roots = children(menus, 'topbar');
  assert.deepEqual(roots.map((item) => item.label), ['首页', ...RESOURCE_GROUPS.map((group) => group.label), '我的收藏']);
  assert.equal(roots[0].href, '/');
  assert.equal(roots.at(-1).href, '/favorites/');
  RESOURCE_GROUPS.forEach((group, index) => {
    const root = roots[index + 1];
    assert.equal(root.kind, 'group');
    assert.equal(root.icon, group.icon);
    assert.deepEqual(root.payload, { groupId: group.id, description: group.description });
    const entries = children(menus, 'topbar', root.id);
    assert.equal(entries.length, group.resources.length + 1);
    group.resources.forEach((resource, i) => {
      assert.equal(entries[i].kind, 'resource');
      assert.equal(entries[i].label, resource.name);
      assert.equal(entries[i].href, resource.url);
      assert.deepEqual(entries[i].payload, { ...resource, target: '_blank', rel: 'noopener noreferrer' });
    });
    assert.equal(entries.at(-1).label, `查看全部${group.label}`);
    assert.equal(entries.at(-1).href, `/discover/#${group.id}`);
  });
  const expectedCount = raw.categories.length + 2 + 1 + 2
    + RESOURCE_GROUPS.reduce((sum, group) => sum + group.resources.length + 2, 0) + 5;
  assert.equal(menus.length, expectedCount, '无额外菜单或遗漏入口');
});

test('用户菜单与通知种子保留原有入口，前台从统一读取层消费', () => {
  const { menus } = buildMenuSeed();
  const [notification, user] = children(menus, 'topbar-actions');
  assert.deepEqual([notification.label, notification.href, notification.icon], ['通知', '/notifications/', 'lucide:bell']);
  assert.equal(user.label, CURRENT_USER.name);
  assert.equal(user.payload.caption, '我的空间');
  assert.deepEqual(children(menus, 'topbar-actions', user.id).map(item => [item.label,item.href,item.icon]), [
    ['我的收藏','/favorites/','lucide:star'], ['最近访问','/history/','lucide:clock'], ['设置','/settings/','lucide:settings'],
  ]);
  const source = readSource('../src/components/layout/Topbar.astro');
  const layout = readSource('../src/layouts/BaseLayout.astro');
  assert.ok(layout.includes('await getPublicMenus()'));
  assert.ok(layout.includes('<Topbar menus={menus} />'));
  assert.ok(source.includes('const { menus } = Astro.props')); 
  assert.ok(!source.includes('RESOURCE_GROUPS'));
});

test('站点基础种子保留，删除热搜与固定分类规则快照', () => {
  const settings = Object.fromEntries(buildMenuSeed().settings.map(({ key, value }) => [key, value]));
  assert.deepEqual(Object.keys(settings).sort(), [
    'site', 'currentUser',
    'homeSectionPageSize', 'legacySites', 'resourceGroups',
  ].sort());
  assert.deepEqual(settings.site, SITE);
  assert.deepEqual(settings.currentUser, CURRENT_USER);
  assert.equal(settings.homeSectionPageSize, HOME_SECTION_PAGE_SIZE);
  assert.deepEqual(settings.legacySites, legacy);
  assert.deepEqual(settings.resourceGroups, RESOURCE_GROUPS);
});

test('细分规则与热搜不再复制到配置种子', () => {
  const keys = buildMenuSeed().settings.map(item => item.key);
  assert.ok(!keys.includes('homeTabRules'));
  assert.ok(!keys.includes('categoryTabs'));
  assert.ok(!keys.includes('hotSearches'));
});
