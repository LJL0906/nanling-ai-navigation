import { requireAdmin } from './auth.ts';
import { api, HttpError, methodNotAllowed } from './http.ts';
import { settingsStore, type SettingsStore } from './settings-store.ts';
import { validateSettingsCommand } from './settings-validation.ts';

export async function readSettingsRequest(request: Request): Promise<unknown> {
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== new URL(request.url).origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'CROSS_ORIGIN_WRITE', '不允许跨站修改配置。');
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'JSON_REQUIRED', '请使用 application/json 提交配置。');
  const limit = 32 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'SETTINGS_BODY_TOO_LARGE', '配置请求超过 32 KiB。');
  if (!request.body) throw new HttpError(400, 'INVALID_JSON', '缺少配置内容。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'SETTINGS_BODY_TOO_LARGE', '配置请求超过 32 KiB。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new HttpError(400, 'INVALID_JSON', '配置必须是有效 JSON。'); }
}
export function createSettingsHandler(store: SettingsStore = settingsStore) {
  return (request: Request): Promise<Response> => api(async () => {
    requireAdmin(request);
    if (!['GET', 'HEAD', 'PUT'].includes(request.method)) return methodNotAllowed('GET, HEAD, PUT');
    if (new URL(request.url).search) throw new HttpError(400, 'INVALID_QUERY', '配置接口不接受查询参数。');
    if (request.method === 'GET' || request.method === 'HEAD') {
      const data = await store.read();
      if (request.method === 'HEAD') return new Response(null, { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
      return { data };
    }
    return { data: await store.write(validateSettingsCommand(await readSettingsRequest(request))) };
  });
}
export const settingsHandler = createSettingsHandler();
