import { readFileSync } from 'node:fs';
import type { PoolOptions } from 'mysql2/promise';
import { HttpError } from './http.ts';

type Environment = Record<string, string | undefined>;
function invalid(message: string): never { throw new HttpError(503, 'DATABASE_CONFIGURATION', message); }

export function getStorageDriver(env: Environment = process.env): 'seed' | 'mysql' {
  const driver = env.NAV_STORAGE ?? 'seed';
  if (driver !== 'seed' && driver !== 'mysql') invalid('NAV_STORAGE 仅支持 seed 或 mysql。');
  return driver;
}

/** 只读取配置，不创建连接；密码原样传递，不拼接URL，支持 #、@ 等特殊字符。 */
export function getMySqlOptions(env: Environment = process.env): PoolOptions {
  const host = env.MYSQL_HOST?.trim();
  const user = env.MYSQL_USER?.trim();
  const database = env.MYSQL_DATABASE?.trim();
  const password = env.MYSQL_PASSWORD;
  if (!host || !user || !database || !password) {
    invalid('请在本地环境变量中填写 MYSQL_HOST、MYSQL_DATABASE、MYSQL_USER 和 MYSQL_PASSWORD。');
  }
  const port = env.MYSQL_PORT ?? '3306';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) invalid('MYSQL_PORT 必须为1至65535的整数。');
  const mode = env.MYSQL_SSL_MODE ?? 'required';
  if (!['required', 'disabled'].includes(mode)) invalid('MYSQL_SSL_MODE 仅支持 required 或 disabled。');
  let ca: string | undefined;
  if (env.MYSQL_SSL_CA) {
    if (mode === 'disabled') invalid('设置 MYSQL_SSL_CA 时不能禁用 TLS。');
    try { ca = readFileSync(env.MYSQL_SSL_CA, 'utf8'); }
    catch { invalid('无法读取 MYSQL_SSL_CA 指定的证书文件。'); }
  }
  return {
    host, port: Number(port), user, password, database,
    charset: 'utf8mb4',
    ssl: mode === 'required' ? { rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) } : undefined,
    connectTimeout: 5000, connectionLimit: 5, maxIdle: 5, idleTimeout: 60000,
    waitForConnections: true, queueLimit: 20, enableKeepAlive: true,
    multipleStatements: false,
  };
}


