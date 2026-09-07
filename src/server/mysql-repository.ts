import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import legacy from '../data/sites.json';
import { adaptNavigation } from '../lib/adapt-navigation';
import type { LegacyCategory } from '../lib/types';
import type { NavigationRepository } from './repository';
import { getMySqlOptions } from './database-config';
import { decodeNavigationRows, type DatabaseRow } from './mysql-reader';
import { HttpError } from './http';
import { navigationCache } from './navigation-cache.ts';

let pool: Pool | undefined;
let connected = false;

/** 仅在mysql模式真正读取时建立池；不在构建或seed模式下触碰远程数据库。 */
export const mysqlRepository: NavigationRepository = {
  get storage() { return { driver: 'mysql', databaseConnected: connected, writable: true }; },
  getNavigation() {
    return navigationCache.get(loadNavigation);
  },
};

async function loadNavigation() {
  let connection: PoolConnection | undefined;
  try {
    pool ??= createPool(getMySqlOptions());
    connection = await pool.getConnection();
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [categories] = await connection.query<RowDataPacket[]>(
      'SELECT id, slug, payload FROM nav_categories ORDER BY sort_order, id');
    const [sites] = await connection.query<RowDataPacket[]>(
      'SELECT id, category_id, slug, payload FROM nav_sites ORDER BY sort_order, id');
    const raw = decodeNavigationRows(categories as DatabaseRow[], sites as DatabaseRow[]);
    const snapshot = adaptNavigation(raw, legacy as { categories: LegacyCategory[] }, undefined, { managed: true });
    await connection.commit();
    connected = true;
    return snapshot;
  } catch (error) {
    connected = false;
    try { await connection?.rollback(); } catch { /* 不暴露驱动异常 */ }
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, 'DATABASE_UNAVAILABLE', '数据库暂不可用，请检查连接配置、TLS及初始化状态。');
  } finally { connection?.release(); }
}
