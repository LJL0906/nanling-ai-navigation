import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.ts';

export const ACCOUNT_COOKIE = 'nav_user_session';
export const ACCOUNT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ACCOUNT_BODY_LIMIT = 4096;
const SCRYPT_OPTIONS = { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let activeHashes = 0;
// OWASP scrypt N=2^17,r=8,p=1；限制并发，避免异步工作队列积压大量高内存任务。
async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeHashes >= 2) throw new HttpError(429, 'ACCOUNT_BUSY', '登录请求较多，请稍后重试。');
  activeHashes++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { activeHashes--; }
}
export async function hashAccountPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$131072$8$1$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}
// 未知账号也执行相同成本的异步哈希，避免直接通过快速失败枚举用户名。
const DUMMY_HASH = `scrypt$131072$8$1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
export async function verifyAccountPassword(password: string, encoded: string | null): Promise<boolean> {
  const valid = typeof encoded === 'string' && /^scrypt\$131072\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(encoded);
  const parts = (valid ? encoded : DUMMY_HASH).split('$');
  const key = await derive(password, Buffer.from(parts[4], 'hex'));
  return timingSafeEqual(key, Buffer.from(parts[5], 'hex')) && valid;
}
export const accountTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export function accountToken(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim())
    .filter(v => v.startsWith(`${ACCOUNT_COOKIE}=`));
  if (values.length !== 1) return null;
  const value = values[0].slice(ACCOUNT_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(value) ? value : null;
}
export function accountCookie(request: Request, token: string, maxAge = ACCOUNT_TTL_MS / 1000): string {
  return `${ACCOUNT_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export function requireAccountOrigin(request: Request): void {
  if (request.headers.get('origin') !== new URL(request.url).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'CROSS_ORIGIN_WRITE', '不允许跨站执行账号操作。');
  }
}
export function validateAccountCredentials(value: unknown): { username: string; password: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'INVALID_CREDENTIALS', '请输入用户名和密码。');
  }
  const { username, password } = value as Record<string, unknown>;
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    throw new HttpError(400, 'INVALID_USERNAME', '用户名需为 3–32 位英文字母、数字或下划线。');
  }
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new HttpError(400, 'INVALID_PASSWORD', '密码长度需为 10–128 个字符。');
  }
  return { username: username.toLowerCase(), password };
}
export async function readAccountCredentials(request: Request): Promise<{ username: string; password: string }> {
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'JSON_REQUIRED', '请使用 JSON 提交账号信息。');
  }
  const length = request.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > ACCOUNT_BODY_LIMIT)) {
    throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大。');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'INVALID_BODY', '请求内容无效。');
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > ACCOUNT_BODY_LIMIT) {
        void reader.cancel().catch(() => {});
        throw new HttpError(413, 'BODY_TOO_LARGE', '请求内容过大。');
      }
      chunks.push(value);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { throw new HttpError(400, 'INVALID_BODY', '请求内容无效。'); }
    return validateAccountCredentials(parsed);
  } finally { reader.releaseLock(); }
}

/** 仅接收适配器提供的客户端地址；不可从请求正文或 X-Forwarded-For 推导来源。
 * 未提供/无法读取地址时，未知来源保守地共享同一来源桶。
 */
export function getAccountSource(context: { readonly clientAddress?: string }): string | undefined {
  try {
    const source = context.clientAddress?.trim();
    return source && source.length <= 128 ? source : undefined;
  } catch { return undefined; }
}

/** 进程内按来源+操作、用户名+操作限流，不信任 X-Forwarded-For。
 * 多实例需可信网关或共享存储统一预算；重启会清空预算。
 * 同 NAT/代理及未知来源会共享来源额度。全局资源保护仅使用短时哈希并发上限。
 */
export function createAccountLimiter(now: () => number = Date.now) {
  const buckets = new Map<string, { count: number; expires: number }>();
  return (action: 'login' | 'register', username?: string, source?: string): void => {
    const time = now();
    for (const [key, bucket] of buckets) if (bucket.expires <= time) buckets.delete(key);
    const key = username ? `user:${action}:${username}` : `source:${action}:${source || 'unknown'}`;
    const max = username ? 10 : action === 'register' ? 30 : 100;
    const bucket = buckets.get(key) ?? { count: 0, expires: time + 15 * 60 * 1000 };
    if (bucket.count >= max || (!buckets.has(key) && buckets.size >= 10000)) {
      throw new HttpError(429, 'ACCOUNT_RATE_LIMITED', '操作过于频繁，请 15 分钟后再试。');
    }
    bucket.count++;
    buckets.set(key, bucket);
  };
}

