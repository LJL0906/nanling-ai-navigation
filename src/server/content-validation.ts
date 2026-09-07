import { createHash } from 'node:crypto';
import lucide from '@iconify-json/lucide/icons.json' with { type: 'json' };
import { HttpError } from './http.ts';

export type ContentKind = 'sites' | 'categories';
export type ContentCommand = {
  kind: ContentKind; id?: string; revision?: string; item?: Record<string, unknown>;
};
const icons = new Set([...Object.keys(lucide.icons), ...Object.keys(lucide.aliases ?? {})]);
const reserved = new Set(['admin', 'api', 'login', 'register', 'categories', 'search', 'tags', 'articles', 'favorites', 'history', 'settings', 'notifications', 'quick-search', 'entertainment', 'discover', '404']);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never { throw new HttpError(400, 'INVALID_CONTENT', message); }
function text(value: unknown, label: string, max: number, empty = false): string {
  if (typeof value !== 'string') invalid(`${label}必须为文本。`);
  const result = value.trim();
  if ((!empty && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) invalid(`${label}为空、过长或含非法控制字符。`);
  return result;
}
export function contentKind(value: unknown): ContentKind {
  if (value !== 'sites' && value !== 'categories') invalid('未知内容模块。');
  return value;
}
export function normalizedContentUrl(value: unknown): string {
  const raw = text(value, '站点地址', 2048);
  if (!/^https?:\/\//i.test(raw) || /[\\\s]/.test(raw)) invalid('站点地址仅支持 HTTP(S)，不能含空白或反斜杠。');
  try {
    const url = new URL(raw);
    if (!url.hostname || url.username || url.password || !['http:', 'https:'].includes(url.protocol)) invalid('站点地址不允许携带账号密码。');
    return url.href;
  } catch { return invalid('站点地址无效。'); }
}
export function contentUrlKey(value: string): string {
  const url = new URL(value); url.hash = ''; url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
export function contentRevision(value: unknown): string {
  function stable(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stable);
    if (object(v)) return Object.fromEntries(Object.keys(v).sort().map(key => [key, stable(v[key])]));
    return v;
  }
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}
export function validateContentCommand(method: string, value: unknown): ContentCommand {
  if (!['POST', 'PATCH', 'DELETE'].includes(method) || !object(value)) invalid('内容请求无效。');
  const allowed = method === 'POST' ? ['kind', 'item'] : method === 'PATCH' ? ['kind', 'id', 'revision', 'item'] : ['kind', 'id', 'revision'];
  if (Object.keys(value).some(key => !allowed.includes(key)) || allowed.some(key => !Object.hasOwn(value, key))) invalid('内容字段缺失或包含未知字段。');
  const kind = contentKind(value.kind);
  const result: ContentCommand = { kind };
  if (method !== 'POST') {
    if (typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)) invalid('记录编号无效。');
    if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) invalid('缺少有效的数据版本，请重新加载。');
    result.id = value.id; result.revision = value.revision;
  }
  if (method === 'DELETE') return result;
  const input = value.item;
  const fields = kind === 'sites' ? ['name', 'slug', 'url', 'category', 'description', 'tags', 'sortOrder'] : ['name', 'slug', 'color', 'icon', 'order'];
  if (!object(input) || Object.keys(input).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(input, key))) invalid('编辑字段缺失或包含未知字段。');
  const name = text(input.name, '名称', 100);
  const slug = text(input.slug, '路径标识', 191);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || (kind === 'categories' && reserved.has(slug))) invalid('路径标识须为小写字母、数字及连字符，且不能占用系统路径。');
  const key = kind === 'sites' ? 'sortOrder' : 'order';
  const order = input[key];
  if (!Number.isSafeInteger(order) || Number(order) < 0 || Number(order) > 1000000) invalid('排序须为 0–1000000 的整数。');
  if (kind === 'sites') {
    const category = text(input.category, '分类', 64);
    if (!/^[a-zA-Z0-9_-]+$/.test(category)) invalid('分类编号无效。');
    if (!Array.isArray(input.tags) || input.tags.length > 30) invalid('标签最多 30 个。');
    const tags = [...new Set(input.tags.map(tag => text(tag, '标签', 50)))];
    result.item = { name, slug, category, url: normalizedContentUrl(input.url), description: text(input.description, '简介', 2000, true), tags, sortOrder: order };
  } else {
    const color = text(input.color, '颜色', 7);
    if (!/^#[a-f0-9]{6}$/i.test(color)) invalid('颜色须为六位十六进制色值。');
    const icon = text(input.icon, '图标', 100);
    if (!icon.startsWith('lucide:') || !icons.has(icon.slice(7))) invalid('请选择已安装的 lucide 图标。');
    result.item = { name, slug, color, icon, order };
  }
  return result;
}

/** 独立小体积 JSON 入口，按实际字节限制，不信任 Content-Length。 */
export async function readContentRequest(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415, 'JSON_REQUIRED', '请提交 JSON 内容。');
  const limit = 16 * 1024;
  const tooLarge = () => new HttpError(413, 'CONTENT_TOO_LARGE', '内容请求不能超过 16 KiB。');
  if (Number(request.headers.get('content-length')) > limit) throw tooLarge();
  if (!request.body) invalid('缺少请求内容。');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return invalid('JSON 内容无效。'); }
}
