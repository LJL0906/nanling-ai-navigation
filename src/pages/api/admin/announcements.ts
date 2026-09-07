import type { APIRoute } from 'astro';
import { createAnnouncementHandler } from '../../../server/notifications-handler.ts';
export const prerender = false;
const handle = createAnnouncementHandler();
export const ALL: APIRoute = ({ request }) => handle(request);
