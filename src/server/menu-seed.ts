import { getSidebarMain } from '../config/nav.ts';
import { SITE, CURRENT_USER } from '../config/site.ts';
import { RESOURCE_GROUPS } from '../data/curated-resources.ts';
import rawNavigation from '../data/导航数据.json' with { type: 'json' };
import legacySites from '../data/sites.json' with { type: 'json' };
import { adaptNavigation } from '../lib/adapt-navigation.ts';
import { HOME_SECTION_PAGE_SIZE } from '../lib/home-sections.ts';
import type { UnifiedNavigation } from '../lib/navigation-types.ts';
import type { LegacyCategory } from '../lib/types.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export interface MenuSeedItem {
  id: string;
  parentId: string | null;
  location: string;
  kind: string;
  label: string;
  href: string | null;
  icon: string | null;
  sortOrder: number;
  enabled: boolean;
  payload: JsonObject;
}
export interface MenuSeedSetting { key: string; value: JsonValue }
export interface MenuSeed { menus: MenuSeedItem[]; settings: MenuSeedSetting[] }

/** 配置均为静态 JSON 数据；复制后调用方修改种子不会污染配置或下一次构建。 */
function copyJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

/**
 * 当前静态 UI 的种子快照，不读取环境变量、不访问仓储或数据库。
 * location 区分显示区域；sortOrder 从 0 开始，仅在同区域、同父节点内排序。
 * id 使用路径/资源标识，不依赖文案或序号。分类 href 保留实际首页锚点，
 * payload.categoryPath 保留分类页路径，menuId 保留侧栏本地排序的原始键。
 * Topbar 内联的用户入口及 Sidebar 底部设置在此显式镜像；不启用未使用的快捷栏。
 */
export function buildMenuSeed(): MenuSeed {
  const { categories } = adaptNavigation(
    rawNavigation as UnifiedNavigation,
    legacySites as { categories: LegacyCategory[] },
    {},
  );
  const menus: MenuSeedItem[] = [];
  const add = (
    id: string, location: string, kind: string, label: string,
    href: string | null, icon: string | null, sortOrder: number,
    parentId: string | null = null, payload: JsonObject = {},
  ) => menus.push({ id, parentId, location, kind, label, href, icon, sortOrder, enabled: true, payload });

  getSidebarMain(categories).forEach((item, index) => {
    const anchor = item.href !== '/' && item.href !== '/categories/' ? item.href.split('/')[1] : null;
    add(`sidebar:${item.href}`, 'sidebar', anchor ? 'category' : 'link', item.label,
      anchor ? `/#${anchor}` : item.href, item.icon, index, null,
      anchor
        ? { menuId: item.href, categoryPath: item.href, homeAnchor: anchor }
        : { menuId: item.href });
  });
  add('sidebar-footer:settings', 'sidebar-footer', 'link', '设置', '/settings/', 'lucide:settings', 0);

  add('topbar:home', 'topbar', 'link', '首页', '/', null, 0);
  RESOURCE_GROUPS.forEach((group, index) => {
    const parentId = `topbar:group:${group.id}`;
    add(parentId, 'topbar', 'group', group.label, null, group.icon, index + 1,
      null, { groupId: group.id, description: group.description });
    group.resources.forEach((resource, resourceIndex) => {
      add(`${parentId}:resource:${resource.id}`, 'topbar', 'resource', resource.name,
        resource.url, null, resourceIndex, parentId,
        { ...resource, target: '_blank', rel: 'noopener noreferrer' });
    });
    add(`${parentId}:all`, 'topbar', 'link', `查看全部${group.label}`,
      `/discover/#${group.id}`, 'lucide:arrow-right', group.resources.length, parentId);
  });
  add('topbar:favorites', 'topbar', 'link', '我的收藏', '/favorites/', null, RESOURCE_GROUPS.length + 1);

  add('topbar-actions:notifications', 'topbar-actions', 'link', '通知', '/notifications/', 'lucide:bell', 0);
  const userId = 'topbar-actions:user';
  add(userId, 'topbar-actions', 'group', CURRENT_USER.name, null, null, 1,
    null, { caption: '我的空间' });
  const userLinks = [
    { id: 'favorites', label: '我的收藏', href: '/favorites/', icon: 'lucide:star' },
    { id: 'history', label: '最近访问', href: '/history/', icon: 'lucide:clock' },
    { id: 'settings', label: '设置', href: '/settings/', icon: 'lucide:settings' },
  ];
  userLinks.forEach((item, index) => {
    add(`${userId}:${item.id}`, 'topbar-actions', 'link', item.label, item.href, item.icon, index, userId);
  });

  const settings = Object.entries({
    site: SITE,
    currentUser: CURRENT_USER,
    homeSectionPageSize: HOME_SECTION_PAGE_SIZE,
    legacySites,
    resourceGroups: RESOURCE_GROUPS,
  }).map(([key, value]) => ({ key, value: copyJson(value) }));
  return { menus, settings };
}
