import type { Category, Site } from './types';
import { buildHomeTabs } from '../config/home-tabs.ts';

export const HOME_SECTION_PAGE_SIZE = 18;
export const HOME_SECTION_MORE_SIZE = 36;

/** SSR 数量通过 data 属性传入客户端；更多批次保持默认的两倍关系。 */
export function getHomeSectionSizes(value: number) {
  const pageSize = Number.isSafeInteger(value) && value > 0 ? value : HOME_SECTION_PAGE_SIZE;
  return { pageSize, moreSize: pageSize * (HOME_SECTION_MORE_SIZE / HOME_SECTION_PAGE_SIZE) };
}

export interface HomeSectionTab { key: string; label: string; indices: number[]; }
export type HomeSite = Pick<Site, 'id' | 'slug' | 'name' | 'url' | 'desc' | 'icon' | 'color' | 'mono' | 'categorySlug'>;
export interface HomeSectionData { slug: string; name: string; sites: HomeSite[]; tabs: HomeSectionTab[]; }

/** 首页和分类页共享动态细分，全部数据保留供分批加载。 */
export function buildHomeSection(category: Category): HomeSectionData {
  const tabs = buildHomeTabs(category);
  return {
    slug: category.slug,
    name: category.name,
    sites: category.sites.map(({ id, slug, name, url, desc, icon, color, mono, categorySlug }) =>
      ({ id, slug, name, url, desc, icon, color, mono, categorySlug })),
    tabs,
  };
}

