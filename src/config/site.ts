/** 全站基础信息与 SEO 默认值。 */
export const SITE = {
  url: 'https://nav.ljianl.com',
  name: '楠灵AI 导航',
  slogan: '发现优质，探索无限',
  heroTitle: '探索优质网站，发现无限可能',
  heroSubtitle: '精心整理的实用网站导航，助你高效获取信息',
  description:
    '楠灵AI 导航——精心整理的实用网站导航，收录搜索引擎、AI 工具、开发工具、设计素材、资讯社区等优质站点，助你高效获取信息。',
  keywords: '网站导航,网址导航,导航站,AI工具,开发工具,设计素材,搜索引擎',
  lastmod: '2026-09-07',
} as const;

/** 顶部导航栏。children 存在时渲染为下拉面板。 */
export const TOP_NAV = [
  {
    label: '导航',
    children: [
      { label: '站点导航', href: '/' },
      { label: '文章导航', href: '/articles/' },
      { label: '快搜导航', href: '/quick-search/' },
      { label: 'Tag 导航', href: '/tags/' },
    ],
  },
  { label: '文章', children: [{ label: '全部文章', href: '/articles/' }] },
  { label: '快搜', children: [{ label: '快搜入口', href: '/quick-search/' }] },
  { label: '工具', children: [{ label: '办公工具', href: '/office/' }] },
  { label: '社区', children: [{ label: '资讯社区', href: '/community/' }] },
] as const;

/** 热门搜索词，对应 Hero 搜索框下方的标签。 */
export const HOT_SEARCHES = ['ChatGPT', 'Notion', 'Figma', 'GitHub', 'Midjourney'] as const;

/** 右上角用户区展示名。 */
export const CURRENT_USER = { name: 'Forest' } as const;

