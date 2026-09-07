import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { assertAccountStorage, withAccountConnection } from './account-db.ts';
import { HttpError } from './http.ts';
import {
  ACCOUNT_TTL_MS, accountCookie, accountToken, accountTokenHash, createAccountLimiter,
  hashAccountPassword, readAccountCredentials, requireAccountOrigin, verifyAccountPassword,
} from './account-security.ts';

export interface AccountUser { id: string; username: string }
interface Dependencies {
  connection: <T>(callback: (connection: PoolConnection) => Promise<T>) => Promise<T>;
  assertStorage: () => void;
  now: () => number;
  hash: typeof hashAccountPassword;
  verify: typeof verifyAccountPassword;
  limit: ReturnType<typeof createAccountLimiter>;
}
const defaultLimit = createAccountLimiter();

/** 注入只供本地无数据库测试；生产实例始终检查 NAV_STORAGE。 */
export function createAccountService(overrides: Partial<Dependencies> = {}) {
  const deps: Dependencies = {
    connection: withAccountConnection, assertStorage: assertAccountStorage, now: Date.now,
    hash: hashAccountPassword, verify: verifyAccountPassword, limit: defaultLimit, ...overrides,
  };
  async function getUser(request: Request): Promise<AccountUser | null> {
    deps.assertStorage();
    const token = accountToken(request);
    if (!token) return null;
    return deps.connection(async connection => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        `SELECT u.id, u.username FROM nav_user_sessions s JOIN nav_users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) LIMIT 1`, [accountTokenHash(token)]);
      return rows[0] ? { id: rows[0].id, username: rows[0].username } : null;
    });
  }
  async function requireUser(request: Request): Promise<AccountUser> {
    const user = await getUser(request);
    if (!user) throw new HttpError(401, 'USER_UNAUTHORIZED', '请先登录普通用户账号。');
    return user;
  }
  async function authenticate(request: Request, action: 'login' | 'register', source?: string) {
    deps.assertStorage();
    requireAccountOrigin(request);
    deps.limit(action, undefined, source);
    const { username, password } = await readAccountCredentials(request);
    deps.limit(action, username);
    let user: AccountUser;
    let passwordHash = '';
    if (action === 'register') {
      // 管理员名仅由部署配置保留；即使尚未配置密码，也不能公开注册占用。
      if (username === process.env.ADMIN_USERNAME?.trim().toLowerCase()) {
        throw new HttpError(409, 'USERNAME_UNAVAILABLE', '该用户名不可用，请换一个用户名。');
      }
      passwordHash = await deps.hash(password);
      user = { id: randomUUID(), username };
    } else {
      const row = await deps.connection(async connection => {
        const [rows] = await connection.execute<RowDataPacket[]>(
          'SELECT id, username, password_hash FROM nav_users WHERE username = ? LIMIT 1', [username]);
        return rows[0];
      });
      const verified = await deps.verify(password, row?.password_hash ?? null);
      if (!row || !verified) throw new HttpError(401, 'LOGIN_FAILED', '用户名或密码错误。');
      user = { id: row.id, username: row.username };
    }
    const token = randomBytes(32).toString('hex');
    const oldToken = accountToken(request);
    const expiresAt = new Date(deps.now() + ACCOUNT_TTL_MS);
    await deps.connection(async connection => {
      await connection.beginTransaction();
      try {
        if (action === 'register') {
          try {
            await connection.execute('INSERT INTO nav_users (id, username, password_hash) VALUES (?, ?, ?)',
              [user.id, user.username, passwordHash]);
          } catch (error) {
            if ((error as { code?: string })?.code === 'ER_DUP_ENTRY') {
              throw new HttpError(409, 'USERNAME_UNAVAILABLE', '该用户名不可用，请换一个用户名。');
            }
            throw error;
          }
        }
        if (oldToken) await connection.execute('DELETE FROM nav_user_sessions WHERE token_hash = ?', [accountTokenHash(oldToken)]);
        await connection.execute('INSERT INTO nav_user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
          [accountTokenHash(token), user.id, expiresAt]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    });
    return { user, cookie: accountCookie(request, token) };
  }
  async function logout(request: Request): Promise<string> {
    deps.assertStorage();
    requireAccountOrigin(request);
    const token = accountToken(request);
    if (token) await deps.connection(async connection => {
      await connection.execute('DELETE FROM nav_user_sessions WHERE token_hash = ?', [accountTokenHash(token)]);
    });
    return accountCookie(request, '', 0);
  }
  return { getUser, requireUser, login: (request: Request, source?: string) => authenticate(request, 'login', source),
    register: (request: Request, source?: string) => authenticate(request, 'register', source), logout };
}
const service = createAccountService();
export const requireUser = service.requireUser;
export const getAccountUser = service.getUser;
export const loginAccount = service.login;
export const registerAccount = service.register;
export const logoutAccount = service.logout;


