import { navigationRepository } from '../server/navigation';
import type { Category, Site } from './types';

/** 仅供服务端页面和 API 使用；客户端使用 /api 或精简搜索索引。 */
export const getNavigation = () => navigationRepository.getNavigation();

export async function getCategory(slug: string): Promise<Category | undefined> {
  const { categories } = await getNavigation();
  return categories.find((category) => category.slug === slug);
}

export function domainOf(site: Site): string { return site.domain; }

export function relatedSites(category: Category, current: Site, limit = 6): Site[] {
  return category.sites.filter((site) => site.id !== current.id).slice(0, limit);
}
