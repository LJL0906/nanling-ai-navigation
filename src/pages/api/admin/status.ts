import type { APIRoute } from 'astro';
import { navigationRepository } from '../../../server/navigation';
import { requireAdmin } from '../../../server/auth';
import { api, methodNotAllowed } from '../../../server/http';

export const GET: APIRoute = ({ request }) => api(async () => {
  requireAdmin(request);
  const snapshot = await navigationRepository.getNavigation();
  return { data: {
    storage: navigationRepository.storage,
    counts: { categories: snapshot.categories.length, sites: snapshot.siteCount,
      unverified: snapshot.categories.reduce((sum, category) =>
        sum + category.sites.filter((site) => site.verification.status === 'unverified').length, 0) },
  } };
});
export const ALL: APIRoute = () => methodNotAllowed();
