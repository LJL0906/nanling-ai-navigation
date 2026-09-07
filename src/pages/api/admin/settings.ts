import type { APIRoute } from 'astro';
import { settingsHandler } from '../../../server/settings-handler';

export const prerender = false;
export const GET: APIRoute = ({ request }) => settingsHandler(request);
export const HEAD: APIRoute = ({ request }) => settingsHandler(request);
export const PUT: APIRoute = ({ request }) => settingsHandler(request);
export const ALL: APIRoute = ({ request }) => settingsHandler(request);
