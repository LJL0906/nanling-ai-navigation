/** 单个站点条目。icon 为 Iconify 图标名，缺失时用 mono 首字渲染兜底方块。 */
export interface Site {
  name: string;
  slug: string;
  url: string;
  desc: string;
  icon: string | null;
  color: string;
  /** icon 为 null 时显示的文字（1-2 个字符） */
  mono?: string;
  /** 大卡片预览图的底色风格 */
  preview?: 'light' | 'blue' | 'dark';
}

/** 分类在首页的展示方式。 */
export interface HomeDisplay {
  show: boolean;
  /** grid = 六列小卡片；preview = 四列带预览图的大卡片 */
  layout: 'grid' | 'preview';
  moreLabel: string;
}

export interface Category {
  slug: string;
  name: string;
  desc: string;
  keywords: string;
  color: string;
  /** 侧边栏图标（Iconify 名） */
  icon: string;
  home: HomeDisplay;
  sites: Site[];
}
