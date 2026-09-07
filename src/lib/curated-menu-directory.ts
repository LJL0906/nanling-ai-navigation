import type { MenuSeedItem } from '../server/menu-seed.ts';
import { curatedPayloadError, safeCuratedHref } from './curated-menu-fields.ts';

/** 只投影公开菜单，不导入静态精选、不缓存、不吞掉数据错误。 */
export function curatedGroupsFromMenus(menus: MenuSeedItem[]) {
  const order = (a: MenuSeedItem, b: MenuSeedItem) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id);
  const groups = menus.filter(m => m.enabled && m.location === 'topbar' && m.kind === 'group' && m.parentId === null).sort(order);
  const anchors = new Set<string>();
  return groups.map(group => {
    const legacyId = group.payload.groupId;
    const id = typeof legacyId === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(legacyId) ? legacyId : `menu-${group.id}`;
    if (anchors.has(id)) throw new Error('精选分组锚点重复，请检查菜单 groupId。');
    anchors.add(id);
    return {
      id, label: group.label, icon: group.icon ?? 'lucide:folder',
      description: typeof group.payload.description === 'string' ? group.payload.description : '',
      resources: menus.filter(m => m.enabled && m.location === 'topbar' && m.kind === 'resource' && m.parentId === group.id).sort(order).map(resource => {
        const error = curatedPayloadError(resource.payload);
        if (error || !safeCuratedHref(resource.href, true)) throw new Error(error ?? '精选资源链接无效。');
        const text = (key: string) => typeof resource.payload[key] === 'string' ? resource.payload[key] as string : '';
        return {
          id: resource.id, name: resource.label, url: resource.href,
          domain: resource.href.startsWith('/') ? '站内资源' : new URL(resource.href).hostname,
          description: text('description'), useCase: text('useCase'),
          sourceUrl: text('sourceUrl'), sourceTitle: text('sourceTitle'), checkedAt: text('checkedAt'),
        };
      }),
    };
  });
}
