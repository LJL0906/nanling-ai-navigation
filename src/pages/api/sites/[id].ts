import type { APIRoute } from 'astro';
import { getNavigation } from '../../../lib/data';
import { api, HttpError, methodNotAllowed } from '../../../server/http';
import { siteSummary } from '../../../server/site-query';

export const GET: APIRoute = ({ params }) => api(async () => {
  const { categories } = await getNavigation();
  const site = categories.flatMap((category) => category.sites).find((entry) => entry.id === params.id);
  if (!site) throw new HttpError(404, 'SITE_NOT_FOUND', '站点不存在。');
  return { data: siteSummary(site) };
});
export const ALL: APIRoute = () => methodNotAllowed();
