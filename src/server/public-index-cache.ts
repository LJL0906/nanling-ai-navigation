import { createHash } from 'node:crypto';
import type { NavigationSnapshot } from './repository';

/** GET 使用弱比较；只匹配完整标签，不对标签内部内容做子串匹配。 */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  // opaque-tag 可以包含逗号，因此不能直接 split(',')。
  const tags = header.match(/(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"/g) ?? [];
  return tags.some(tag => tag.replace(/^W\//, '') === etag);
}

/**
 * 每个公开端点各建一个实例；WeakMap 不阻止旧快照回收。
 * 快照视为不可变：身份不变时复用正文和 ETag，身份变化重新投影、序列化。
 * 不增加 TTL；客户端可以存储，但每次使用都须向服务端验证。
 * 仅适用于公开索引，禁止用于个人鉴权数据。
 */
export function createPublicIndexCache(project: (snapshot: NavigationSnapshot) => unknown) {
  const entries = new WeakMap<NavigationSnapshot, { body: string; etag: string }>();
  return (snapshot: NavigationSnapshot, request: Request): Response => {
    let entry = entries.get(snapshot);
    if (!entry) {
      const body = JSON.stringify(project(snapshot));
      if (body === undefined) throw new TypeError('公开索引必须可以序列化为 JSON。');
      const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      entry = { body, etag };
      entries.set(snapshot, entry);
    }
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, no-cache',
      ETag: entry.etag,
    };
    return matchesEtag(request.headers.get('If-None-Match'), entry.etag)
      ? new Response(null, { status: 304, headers })
      : new Response(entry.body, { headers });
  };
}
