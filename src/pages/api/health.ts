import type { APIRoute } from 'astro';
import { navigationRepository } from '../../server/navigation';
import { api, methodNotAllowed } from '../../server/http';

export const GET: APIRoute = () => api(async () => {
  await navigationRepository.getNavigation();
  return { data: { status: 'ok', storage: navigationRepository.storage.driver, databaseConnected: navigationRepository.storage.databaseConnected } };
});
export const ALL: APIRoute = () => methodNotAllowed();

