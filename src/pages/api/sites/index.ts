import type { APIRoute } from 'astro';
import { getNavigation } from '../../../lib/data';
import { api, methodNotAllowed } from '../../../server/http';
import { listSites, parseSiteQuery } from '../../../server/site-query';

export const GET: APIRoute = ({ url }) => api(async () => {
  const query = parseSiteQuery(url.searchParams);
  return listSites(await getNavigation(), query);
});
export const ALL: APIRoute = () => methodNotAllowed();
