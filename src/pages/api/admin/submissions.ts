import type { APIRoute } from 'astro';
import { createSubmissionReviewHandler } from '../../../server/submission-review';

export const prerender = false;
const handle = createSubmissionReviewHandler();
export const GET: APIRoute = ({ request }) => handle(request);
export const PATCH: APIRoute = ({ request }) => handle(request);
export const ALL: APIRoute = ({ request }) => handle(request);
