import type { APIRoute } from 'astro';
import { getPublicMenus } from '../../server/menus';
import { api, methodNotAllowed } from '../../server/http';

export const GET: APIRoute = () => api(async () => ({ data: await getPublicMenus() }));
export const ALL: APIRoute = () => methodNotAllowed();
