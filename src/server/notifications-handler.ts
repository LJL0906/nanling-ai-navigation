import { getAccountUser, requireUser } from './account.ts';
import { requireAdmin } from './auth.ts';
import { api, HttpError, methodNotAllowed } from './http.ts';
import { readContentRequest } from './content-validation.ts';
import { notificationQuery, notificationStore } from './notifications.ts';

export function createNotificationHandler(deps = { getAccountUser, requireUser, store: notificationStore }) {
  return (request: Request) => api(async () => {
    if (request.method !== 'GET') return methodNotAllowed('GET');
    const query = notificationQuery(new URL(request.url).searchParams);
    const user = await (query.kind === 'submission' ? deps.requireUser(request) : deps.getAccountUser(request));
    return { data: { ...await deps.store.list(query, user?.id ?? null), user: user ? { id: user.id, username: user.username } : null } };
  });
}
export function createAnnouncementHandler(store = notificationStore) {
  return (request: Request) => api(async () => {
    requireAdmin(request);
    const params = new URL(request.url).searchParams;
    if (request.method === 'GET') return { data: await store.list(notificationQuery(params, true), null) };
    if (!['POST', 'PUT', 'DELETE'].includes(request.method)) return methodNotAllowed('GET, POST, PUT, DELETE');
    if (params.size) throw new HttpError(400, 'INVALID_QUERY', '公告写入参数须放在 JSON 请求体中。');
    return { data: await store.write(request.method, await readContentRequest(request)) };
  });
}
