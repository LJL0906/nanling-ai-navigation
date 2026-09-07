import type { APIRoute } from 'astro';
import { api, methodNotAllowed } from '../../server/http.ts';
import { requireUser } from '../../server/account.ts';
import { readPersonal, writePersonal } from '../../server/personal.ts';
import { readPersonalAction } from '../../server/personal-validation.ts';
export const prerender = false;
export const GET: APIRoute = ({request}) => api(async () => ({data:await readPersonal((await requireUser(request)).id)}));
export const POST: APIRoute = ({request}) => api(async () => {
  const user = await requireUser(request);
  return {data:await writePersonal(user.id,await readPersonalAction(request))};
});
export const ALL: APIRoute = () => methodNotAllowed('GET, POST');
