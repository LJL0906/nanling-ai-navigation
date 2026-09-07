import { HttpError } from './http.ts';

/** 请求流限额，不能只信任 Content-Length，避免大体积 JSON 耗尽内存。 */
export async function readMenuRequest(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403,'CROSS_ORIGIN_WRITE','不允许跨站修改菜单。');
  if (request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403,'CROSS_ORIGIN_WRITE','不允许跨站修改菜单。');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415,'JSON_REQUIRED','请使用 application/json 提交菜单。');
  const limit = 512 * 1024;
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413,'MENU_BODY_TOO_LARGE','菜单请求超过 512 KiB。');
  if (!request.body) throw new HttpError(400,'INVALID_JSON','缺少请求内容。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new HttpError(413,'MENU_BODY_TOO_LARGE','菜单请求超过 512 KiB。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k=>!['menus','revision'].includes(k))) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400,'INVALID_JSON','请求必须是包含 menus 和 revision 的 JSON 对象。'); }
}
