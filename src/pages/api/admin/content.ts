import type { APIRoute } from 'astro';
import { createContentHandler } from '../../../server/content-handler.ts';
export const prerender = false;
const handle = createContentHandler();
export const ALL: APIRoute = ({ request }) => handle(request);
