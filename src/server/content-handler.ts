import { requireAdmin } from './auth.ts';
import { api, HttpError, methodNotAllowed } from './http.ts';
import { contentKind, readContentRequest, validateContentCommand } from './content-validation.ts';
import { contentStore } from './content-store.ts';

export function createContentHandler(store = contentStore) {
  return (request: Request) => api(async () => {
    requireAdmin(request);
    const params = new URL(request.url).searchParams;
    if (request.method === 'GET') {
      if ([...params.keys()].some(key => key !== 'kind') || params.getAll('kind').length !== 1) throw new HttpError(400, 'INVALID_QUERY', '请指定唯一内容模块。');
      return { data: await store.list(contentKind(params.get('kind'))) };
    }
    if (!['POST', 'PATCH', 'DELETE'].includes(request.method)) return methodNotAllowed('GET, POST, PATCH, DELETE');
    if (params.size) throw new HttpError(400, 'INVALID_QUERY', '写入参数必须放入 JSON 请求体。');
    const command = validateContentCommand(request.method, await readContentRequest(request));
    return { data: await store.write(request.method, command) };
  });
}
