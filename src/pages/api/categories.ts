import type { APIRoute } from 'astro';
import { getNavigation } from '../../lib/data';
import { api, methodNotAllowed } from '../../server/http';

export const GET: APIRoute = () => api(async () => {
  const { categories } = await getNavigation();
  return { data: categories.map(({ id, slug, name, desc, icon, color, sites }) =>
    ({ id, slug, name, desc, icon, color, siteCount: sites.length })) };
});
export const ALL: APIRoute = () => methodNotAllowed();
