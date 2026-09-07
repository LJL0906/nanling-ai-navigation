import type { APIRoute } from 'astro';
import { getNavigation } from '../lib/data';
import { createPublicIndexCache } from '../server/public-index-cache.ts';

/** 分类集中存储；terms 只存展示字段之外的检索文本，不下发原始来源记录。 */
export interface SearchIndex {
  version: 1;
  categories: { slug: string; name: string }[];
  sites: {
    id: string;
    url: string;
    slug: string;
    name: string;
    desc: string;
    color: string;
    icon: string | null;
    mono?: string;
    category: number;
    terms: string;
  }[];
}

export const prerender = false;

const respond = createPublicIndexCache(({ categories }) => {
  const categoryIds = new Map(categories.map((category, index) => [category.slug, index]));
  const index: SearchIndex = {
    version: 1,
    categories: categories.map(({ slug, name }) => ({ slug, name })),
    sites: categories.flatMap((category) => category.sites.map((site) => {
      const categoryId = categoryIds.get(site.categorySlug);
      if (categoryId === undefined) throw new Error(`搜索索引分类不存在：${site.categorySlug}`);
      return {
        id: site.id,
        url: site.url,
        slug: site.slug,
        name: site.name,
        desc: site.desc,
        color: site.color,
        icon: site.icon,
        mono: site.mono,
        category: categoryId,
        terms: [...site.aliases, site.domain, ...site.tags, ...site.sourceCategories].join('\n'),
      };
    })),
  };
  return index;
});

export const GET: APIRoute = async ({ request }) => respond(await getNavigation(), request);
