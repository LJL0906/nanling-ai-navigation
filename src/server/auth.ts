import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from './http.ts';
import { getAdminSession, hasAdminAccount, requireSameOrigin } from './admin-session.ts';

/** Bearer 继续兼容 CLI；Cookie 会话的写请求必须携带本站 Origin。 */
export function requireAdmin(request: Request, configuredToken = process.env.ADMIN_TOKEN): void {
  const tokenConfigured = !!configuredToken && configuredToken.length >= 32 && configuredToken.length <= 512 && configuredToken.trim() === configuredToken;
  const match = /^Bearer ([\x21-\x7e]{32,512})$/.exec(request.headers.get('authorization') ?? '');
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (tokenConfigured && match && timingSafeEqual(digest(match[1]), digest(configuredToken!))) return;
  if (getAdminSession(request)) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) requireSameOrigin(request);
    return;
  }
  if (!tokenConfigured && !hasAdminAccount()) {
    throw new HttpError(503, 'ADMIN_NOT_CONFIGURED', '管理入口未启用，请配置管理员账户或至少32字符的随机 ADMIN_TOKEN。');
  }
  throw new HttpError(401, 'UNAUTHORIZED', '管理员会话或管理令牌无效或缺失。');
}
