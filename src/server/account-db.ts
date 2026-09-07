import { createPool, type Pool, type PoolConnection } from 'mysql2/promise';
import { getMySqlOptions } from './database-config.ts';
import { HttpError } from './http.ts';

let pool: Pool | undefined;
export function assertAccountStorage(): void {
  if (process.env.NAV_STORAGE !== 'mysql') {
    throw new HttpError(503, 'ACCOUNT_UNAVAILABLE', '用户账号服务需要启用 MySQL 存储。');
  }
}

/** 与个人数据 API 共用；不读取 .env、不自动建表、不返回驱动异常。 */
export async function withAccountConnection<T>(callback: (connection: PoolConnection) => Promise<T>): Promise<T> {
  assertAccountStorage();
  let connection: PoolConnection | undefined;
  try {
    pool ??= createPool({ ...getMySqlOptions(), timezone: 'Z' });
    connection = await pool.getConnection();
    return await callback(connection);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'ACCOUNT_DATABASE_UNAVAILABLE', '用户服务暂时不可用，请稍后重试。');
  } finally {
    connection?.release();
  }
}
