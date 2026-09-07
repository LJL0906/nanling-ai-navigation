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


export interface CategoryTab {
  key: string;
  label: string;
  siteSlugs: string[];
}

/** 分类页精选筛选项。只展示有明确内容归属的分类，避免把来源标签直接暴露给用户。 */
export const CATEGORY_TABS: Record<string, CategoryTab[]> = {
  ai: [
    { key: 'chat', label: 'AI 对话', siteSlugs: ['chatgpt', 'claude'] },
    { key: 'image', label: 'AI 绘画', siteSlugs: ['midjourney'] },
    { key: 'writing', label: 'AI 写作', siteSlugs: ['copy-ai'] },
    { key: 'office', label: 'AI 办公', siteSlugs: ['notion-ai'] },
    { key: 'music', label: 'AI 音乐', siteSlugs: ['suno'] },
  ],
  design: [
    { key: 'design', label: '在线设计', siteSlugs: ['figma'] },
    { key: 'images', label: '图片素材', siteSlugs: ['unsplash', 'pexels'] },
    { key: 'icons', label: '图标素材', siteSlugs: ['iconfont'] },
    { key: 'colors', label: '配色工具', siteSlugs: ['coolors'] },
    { key: 'community', label: '设计社区', siteSlugs: ['dribbble'] },
  ],
  dev: [
    { key: 'code-hosting', label: '代码托管', siteSlugs: ['github', 'gitee'] },
    { key: 'containers', label: '容器工具', siteSlugs: ['docker'] },
    { key: 'api', label: 'API 工具', siteSlugs: ['postman'] },
    { key: 'qa', label: '开发问答', siteSlugs: ['stack-overflow'] },
    { key: 'editor', label: '代码编辑器', siteSlugs: ['vs-code'] },
  ],
};
