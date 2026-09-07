import type { APIRoute } from 'astro';
import { getNavigation } from '../../lib/data';
import { methodNotAllowed } from '../../server/http.ts';
import { createSubmissionHandler } from '../../server/site-submissions.ts';

export const prerender = false;
const submit = createSubmissionHandler({ getCategories: async () => (await getNavigation()).categories });

export const POST: APIRoute = (context) => {
  // 无客户端地址的适配器共用保守限流桶，不使用可伪造的请求头。
  let address = '';
  try { address = context.clientAddress; } catch { /* 无地址时保守降级。 */ }
  return submit(context.request, address);
};
export const ALL: APIRoute = () => methodNotAllowed('POST');
