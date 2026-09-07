import type { APIRoute } from 'astro';
import { getNavigation } from '../lib/data';
import { createPublicIndexCache } from '../server/public-index-cache.ts';

/** 公开站点资料索引；个人收藏与访问记录由鉴权的 /api/personal 独立读写。 */
export const prerender = false;
const respond = createPublicIndexCache(({ categories }) => {
  return categories.flatMap((category) =>
    category.sites.map(({ id, name, slug, url, desc, color, mono, icon }) =>
      ({ id, name, slug, url, desc, color, mono, icon, categorySlug: category.slug, categoryName: category.name }))
  );
});

export const GET: APIRoute = async ({ request }) => respond(await getNavigation(), request);
