import type { APIRoute } from 'astro';
import { getAccountUser, loginAccount, logoutAccount } from '../../../server/account.ts';
import { getAccountSource } from '../../../server/account-security.ts';
import { api, json, methodNotAllowed } from '../../../server/http.ts';
export const prerender = false;
export const GET: APIRoute = ({ request }) => api(async () => ({ data: { user: await getAccountUser(request) } }));
export const POST: APIRoute = (context) => api(async () => {
  const { user, cookie } = await loginAccount(context.request, getAccountSource(context));
  return json({ data: { user } }, 200, { 'Set-Cookie': cookie });
});
export const DELETE: APIRoute = ({ request }) => api(async () =>
  json({ data: { user: null } }, 200, { 'Set-Cookie': await logoutAccount(request) }));
export const ALL: APIRoute = () => methodNotAllowed('GET, POST, DELETE');

