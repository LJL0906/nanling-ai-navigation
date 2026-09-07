import type { APIRoute } from 'astro';
import { getAdminSession, loginAdmin, logoutAdmin } from '../../../server/admin-session.ts';
import { api, HttpError, json, methodNotAllowed } from '../../../server/http.ts';

export const GET: APIRoute = ({ request }) => api(() => {
  const session = getAdminSession(request);
  if (!session) throw new HttpError(401, 'UNAUTHORIZED', '请先登录管理员账户。');
  return { data: session };
});
export const POST: APIRoute = ({ request }) => api(async () => {
  const session = await loginAdmin(request);
  return json({ data: { username: session.username } }, 200, { 'Set-Cookie': session.cookie });
});
export const DELETE: APIRoute = ({ request }) => api(() =>
  json({ data: { username: null } }, 200, { 'Set-Cookie': logoutAdmin(request) }));
export const ALL: APIRoute = () => methodNotAllowed('GET, HEAD, POST, DELETE');
