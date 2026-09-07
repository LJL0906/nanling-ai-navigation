import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.ts';

export const ADMIN_SESSION_COOKIE = 'admin_session';
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const sessions = new Map<string, { username: string; fingerprint: string; expiresAt: number }>();
// 单管理员全局失败预算：不信任可伪造的 X-Forwarded-For；多进程部署需共享存储。
let failures = { count: 0, resetsAt: 0 };
const digest = (value: string) => createHash('sha256').update(value).digest();
const equal = (a: string, b: string) => timingSafeEqual(digest(a), digest(b));

function credentials() {
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  if (!username || !username.trim() || !password || !password.trim()) return null;
  return { username, password, fingerprint: digest(JSON.stringify([username, password])).toString('hex') };
}

export function hasAdminAccount(): boolean { return credentials() !== null; }

function sessionId(request: Request): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';')
    .map(value => value.trim()).filter(value => value.startsWith(`${ADMIN_SESSION_COOKIE}=`));
  if (values.length !== 1) return null;
  const id = values[0].slice(ADMIN_SESSION_COOKIE.length + 1);
  return /^[a-f0-9]{64}$/.test(id) ? id : null;
}

export function getAdminSession(request: Request, now = Date.now()): { username: string } | null {
  const id = sessionId(request);
  if (!id) return null;
  const session = sessions.get(id);
  const config = credentials();
  if (!session) return null;
  if (session.expiresAt <= now || !config || session.fingerprint !== config.fingerprint) {
    sessions.delete(id);
    return null;
  }
  return { username: session.username };
}

export function requireSameOrigin(request: Request): void {
  if (request.headers.get('origin') !== new URL(request.url).origin ||
      request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError(403, 'CROSS_ORIGIN_WRITE', '不允许跨站执行管理操作。');
  }
}

function cookie(request: Request, id: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${ADMIN_SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

export function logoutAdmin(request: Request): string {
  requireSameOrigin(request);
  const id = sessionId(request);
  if (id) sessions.delete(id);
  return cookie(request, '', 0);
}

async function readCredentials(request: Request): Promise<{ username: string; password: string }> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'JSON_REQUIRED', '请使用 application/json 登录。');
  }
  const limit = 8192;
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'BODY_TOO_LARGE', '登录请求过大。');
  if (!request.body) throw new HttpError(400, 'INVALID_JSON', '缺少登录信息。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); throw new HttpError(413, 'BODY_TOO_LARGE', '登录请求过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).some(key => !['username', 'password'].includes(key)) ||
        typeof body.username !== 'string' || typeof body.password !== 'string') throw new Error();
    return body;
  } catch { throw new HttpError(400, 'INVALID_JSON', '请提供 username 和 password 字符串。'); }
}

export async function loginAdmin(request: Request, now = Date.now()): Promise<{ username: string; cookie: string }> {
  requireSameOrigin(request);
  const config = credentials();
  if (!config) throw new HttpError(503, 'ADMIN_NOT_CONFIGURED', '管理员账户未配置。');
  if (now >= failures.resetsAt) failures = { count: 0, resetsAt: now + LOGIN_WINDOW_MS };
  if (failures.count >= 10) throw new HttpError(429, 'LOGIN_RATE_LIMITED', '登录失败次数过多，请15分钟后重试。');
  // 在异步读取之前占用预算，防止并发请求绕过限流；合法登录退还本次预算。
  const budget = failures;
  budget.count++;
  const body = await readCredentials(request);
  const usernameMatches = equal(body.username, config.username);
  const passwordMatches = equal(body.password, config.password);
  if (!usernameMatches || !passwordMatches) throw new HttpError(401, 'UNAUTHORIZED', '用户名或密码错误。');
  budget.count--;
  for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
  if (sessions.size >= 1000) throw new HttpError(503, 'SESSION_LIMIT', '会话数量已达上限，请稍后重试。');
  const oldId = sessionId(request);
  if (oldId) sessions.delete(oldId);
  const id = randomBytes(32).toString('hex');
  sessions.set(id, { username: config.username, fingerprint: config.fingerprint, expiresAt: now + SESSION_TTL_MS });
  return { username: config.username, cookie: cookie(request, id, SESSION_TTL_MS / 1000) };
}

/** next 仅允许规范的本站管理路径，拒绝编码绕过、反斜杠及登录循环。 */
export function safeAdminNext(value: string | null | undefined): string {
  if (!value || !/^\/admin(?:\/|$)/.test(value) || /[\\\s\u0000-\u001f\u007f]/.test(value)) return '/admin/';
  const path = value.split(/[?#]/, 1)[0];
  if (path.includes('%') || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) return '/admin/';
  const url = new URL(value, 'https://admin.invalid');
  if (url.pathname === '/admin/login' || url.pathname.startsWith('/admin/login/')) return '/admin/';
  return `${url.pathname}${url.search}${url.hash}`;
}
