import { categories } from '../lib/data';

export interface SidebarItem {
  label: string;
  href: string;
  icon: string;
}

/** 侧边栏主菜单：首页 + 热门推荐 + 全部分类，顺序对齐设计稿。 */
export const SIDEBAR_MAIN: SidebarItem[] = [
  { label: '首页', href: '/', icon: 'lucide:house' },
  { label: '热门推荐', href: '/#ai', icon: 'lucide:flame' },
  ...categories.map((c) => ({ label: c.name, href: `/${c.slug}/`, icon: c.icon })),
  { label: '更多分类', href: '/categories/', icon: 'lucide:ellipsis' },
];

/** 侧边栏第二组：收藏与历史，均为本地功能入口。 */
export const SIDEBAR_SHORTCUTS: SidebarItem[] = [
  { label: '我的收藏', href: '/favorites/', icon: 'lucide:star' },
  { label: '最近访问', href: '/history/', icon: 'lucide:clock' },
];
