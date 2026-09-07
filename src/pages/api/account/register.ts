import type { APIRoute } from 'astro';
import { registerAccount } from '../../../server/account.ts';
import { getAccountSource } from '../../../server/account-security.ts';
import { api, json, methodNotAllowed } from '../../../server/http.ts';
export const prerender = false;
export const POST: APIRoute = (context) => api(async () => {
  const { user, cookie } = await registerAccount(context.request, getAccountSource(context));
  return json({ data: { user } }, 201, { 'Set-Cookie': cookie });
});
export const ALL: APIRoute = () => methodNotAllowed('POST');

