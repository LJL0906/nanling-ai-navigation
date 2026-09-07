import type { APIRoute } from 'astro';
import { createNotificationHandler } from '../../server/notifications-handler.ts';
export const prerender = false;
const handle = createNotificationHandler();
export const ALL: APIRoute = ({ request }) => handle(request);
