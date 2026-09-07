import type { APIRoute } from 'astro';
import { getNavigation } from '../lib/data';
import { createPublicIndexCache } from '../server/public-index-cache.ts';

/** 按需加载历史词到官网的索引，避免每个页面内嵌全量数据。 */
export const prerender = false;

const respond = createPublicIndexCache(({ categories }) => {
  const destinations: Record<string, string | null> = Object.create(null);
  for (const category of categories) {
    for (const site of category.sites) {
      for (const value of [site.name, site.slug, site.url, new URL(site.url).hostname, ...site.aliases]) {
        const key = value.trim().toLowerCase().replace(/\/$/, '');
        if (!key) continue;
        if (!Object.hasOwn(destinations, key)) destinations[key] = site.url;
        else if (destinations[key] !== site.url) destinations[key] = null;
      }
    }
  }
  return destinations;
});

export const GET: APIRoute = async ({ request }) => respond(await getNavigation(), request);
