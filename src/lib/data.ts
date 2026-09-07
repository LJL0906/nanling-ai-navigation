import raw from '../data/sites.json';
import type { Category, Site } from './types';

export const categories = raw.categories as Category[];

/** 首页按顺序展示的分类。 */
export const homeCategories = categories.filter((c) => c.home.show);

export function getCategory(slug: string): Category | undefined {
  return categories.find((c) => c.slug === slug);
}

/** 站点总数，用于文案与结构化数据。 */
export const siteCount = categories.reduce((n, c) => n + c.sites.length, 0);

/** 去掉协议前缀，用于展示域名。 */
export function domainOf(site: Site): string {
  return site.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** 同分类下的其它站点，用于详情页推荐。 */
export function relatedSites(category: Category, current: Site, limit = 6): Site[] {
  return category.sites.filter((s) => s.slug !== current.slug).slice(0, limit);
}
