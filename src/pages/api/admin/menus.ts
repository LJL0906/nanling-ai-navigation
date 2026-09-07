import type { APIRoute } from 'astro';
import { getMenuSnapshot, saveMenus } from '../../../server/menus';
import { requireAdmin } from '../../../server/auth';
import { api, methodNotAllowed } from '../../../server/http';
import { readMenuRequest } from '../../../server/menu-request';

export const GET: APIRoute = ({request}) => api(async () => {
  requireAdmin(request);
  return {data:await getMenuSnapshot()};
});
export const PUT: APIRoute = ({request}) => api(async () => {
  requireAdmin(request);
  const body = await readMenuRequest(request);
  return {data:await saveMenus(body.menus, body.revision)};
});
export const ALL: APIRoute = () => methodNotAllowed('GET, HEAD, PUT');
