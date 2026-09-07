import type { Category, LegacyCategory, LegacySite, Site } from './types';
import type { UnifiedNavigation } from './navigation-types';
import localIcons from '../data/站点图标.json' with { type: 'json' };
import { isBrandIcon } from './brand-icon.ts';
import { isLocalSiteIcon } from './site-icon.ts';

/** 只补齐新增分类的展示文案，不改动统一站点库的分类结果。 */
const descriptions: Record<string, string> = {
  shopping: '购物、电商与出行服务，按需查找生活消费入口。',
  jobs: '招聘、求职与职业发展资源，探索工作机会。',
  media: '影视、音乐、阅读与内容平台，发现感兴趣的作品。',
  games: '游戏资讯、游戏平台与互动娱乐资源。',
  fun: '创意、有趣的小站与互动体验，发现网络乐趣。',
  tools: '格式转换、文件处理与实用在线工具。',
  other: '综合导航与其他资源入口，探索更多网站。',
};

export interface SiteRedirect {
  from: string;
  to: string;
}

export function adaptNavigation(
  raw: UnifiedNavigation,
  legacy: { categories: LegacyCategory[] },
  manifest: Readonly<Record<string, unknown>> = localIcons,
  options: { managed?: boolean } = {},
) {
  const categoryById = new Map(raw.categories.map((category) => [category.id, category]));
  const legacyCategories = new Map(legacy.categories.map((category) => [category.slug, category]));
  const legacySites = new Map<string, { site: LegacySite; order: number }>();
  let order = 0;
  for (const category of legacy.categories) {
    for (const site of category.sites) {
      legacySites.set(`${category.slug}/${site.slug}`, { site, order: order++ });
    }
  }

  const groups = new Map<string, { site: Site; order: number }[]>();
  const redirects = new Map<string, string>();
  for (const entry of raw.sites) {
    const category = categoryById.get(entry.category);
    if (!category) throw new Error(`站点 ${entry.id} 引用了不存在的分类 ${entry.category}`);
    const originals = entry.sources
      .filter((source) => source.dataset === 'sites.json')
      .map((source) => legacySites.get(source.recordId))
      .filter((item): item is { site: LegacySite; order: number } => Boolean(item))
      .sort((a, b) => a.order - b.order);
    const original = originals[0];
    const brandIcon = entry.icon?.type === 'iconify' && isBrandIcon(entry.icon.value)
      ? entry.icon.value
      : originals.find(({ site }) => isBrandIcon(site.icon))?.site.icon;
    const localIcon = Object.hasOwn(manifest, entry.id) ? manifest[entry.id] : null;
    const site: Site = {
      id: entry.id,
      slug: entry.slug,
      name: entry.name,
      url: entry.url,
      desc: entry.description.trim() || `${entry.name}，${category.name}相关网站。`,
      // 保留有效品牌图标；仅从本地白名单读取图片，原始 URL/raw 永不加载。
      icon: brandIcon ?? (isLocalSiteIcon(localIcon) ? localIcon : null),
      color: entry.icon?.color ?? original?.site.color ?? category.color,
      mono: original?.site.mono ?? Array.from(entry.name)[0] ?? '?',
      preview: original?.site.preview,
      categorySlug: category.slug,
      aliases: entry.aliases,
      alternateUrls: entry.alternateUrls,
      domain: entry.domain,
      tags: entry.tags,
      sourceCategories: entry.sourceCategories,
      sourceIcon: entry.icon,
      sources: entry.sources,
      verification: entry.verification,
    };
    const group = groups.get(category.id) ?? [];
    group.push({ site, order: options.managed ? 0 : original?.order ?? Number.MAX_SAFE_INTEGER });
    groups.set(category.id, group);

    const to = `/${category.slug}/${site.slug}/`;
    for (const source of entry.sources.filter((item) => item.dataset === 'sites.json')) {
      const from = `/${source.recordId}/`;
      if (from !== to) {
        if (redirects.has(from) && redirects.get(from) !== to) {
          throw new Error(`旧站点路径指向多个目标：${from}`);
        }
        redirects.set(from, to);
      }
    }
  }

  const categories: Category[] = [...raw.categories]
    .sort((a, b) => a.order - b.order)
    .map((category) => {
      const original = legacyCategories.get(category.slug);
      return {
        id: category.id,
        slug: category.slug,
        name: category.name,
        desc: original?.desc ?? descriptions[category.slug] ?? `${category.name}相关网站与资源。`,
        keywords: original?.keywords ?? `${category.name},网站导航,实用网站`,
        color: options.managed ? category.color : original?.color ?? category.color,
        icon: options.managed ? category.icon : original?.icon ?? category.icon,
        home: {
          show: original?.home.show ?? false,
          layout: original?.home.layout ?? 'grid',
          moreLabel: original?.home.moreLabel ?? '更多',
          limit: original?.sites.length ?? 6,
        },
        sites: (groups.get(category.id) ?? [])
          .sort((a, b) => a.order - b.order)
          .map(({ site }) => site),
      };
    });
  const bySlug = new Map(categories.map((category) => [category.slug, category]));
  const canonicalPaths = new Set(categories.flatMap((category) =>
    category.sites.map((site) => `/${category.slug}/${site.slug}/`)));
  for (const [from, to] of redirects) {
    if (canonicalPaths.has(from)) throw new Error(`旧链接与新站点路径冲突：${from}`);
    if (!canonicalPaths.has(to)) throw new Error(`旧链接目标不存在：${to}`);
  }

  // 首页沿用原有分区顺序、卡片数量；分类页和搜索仍持有完整 sites。
  const homeCategories = legacy.categories
    .filter((category) => category.home.show)
    .map((category) => bySlug.get(category.slug))
    .filter((category): category is Category => Boolean(category))
    .map((category) => ({ ...category, sites: category.sites.slice(0, category.home.limit) }));

  return {
    categories,
    homeCategories,
    siteCount: raw.sites.length,
    siteRedirects: Array.from(redirects, ([from, to]): SiteRedirect => ({ from, to })),
  };
}
