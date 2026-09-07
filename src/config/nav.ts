import type { Category } from '../lib/types';

export interface SidebarItem {
  label: string;
  href: string;
  icon: string;
}

/** 侧边栏主菜单：首页 + 全部分类（热门推荐暂不展示），顺序对齐设计稿。 */
export function getSidebarMain(categories: Category[]): SidebarItem[] {
  return [
    { label: '首页', href: '/', icon: 'lucide:house' },
    ...categories.map((c) => ({ label: c.name, href: `/${c.slug}/`, icon: c.icon })),
    { label: '更多分类', href: '/categories/', icon: 'lucide:ellipsis' },
  ];
}

/** 侧边栏第二组：收藏与历史，均为本地功能入口。 */
export const SIDEBAR_SHORTCUTS: SidebarItem[] = [
  { label: '我的收藏', href: '/favorites/', icon: 'lucide:star' },
  { label: '最近访问', href: '/history/', icon: 'lucide:clock' },
];


/** 分类细分由当前站点快照派生。 */
export { buildCategoryFacets as getCategoryTabs } from '../lib/category-facets.ts';
export type { CategoryFacet as CategoryTab } from '../lib/category-facets.ts';
