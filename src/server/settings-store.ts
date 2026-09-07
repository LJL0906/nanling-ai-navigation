import { createHash } from 'node:crypto';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { SITE } from '../config/site.ts';
import { HOME_SECTION_PAGE_SIZE } from '../lib/home-sections.ts';
import { getMySqlOptions, getStorageDriver } from './database-config.ts';
import { HttpError } from './http.ts';
import { readStoredSiteSettings, validateSettings, validateSettingsCommand,
  type RuntimeSettings, type SettingsCommand, type SettingsSnapshot } from './settings-validation.ts';
export type { SiteSettings, RuntimeSettings, SettingsSnapshot, SettingsCommand } from './settings-validation.ts';

export interface SettingsStore {
  read(): Promise<SettingsSnapshot>;
  write(command: SettingsCommand): Promise<SettingsSnapshot>;
}
let pool: Pool | undefined;
const getPool = () => pool ??= createPool(getMySqlOptions());
const keys = ['site', 'homeSectionPageSize'];
const lockName = 'nav_settings_write';
export function defaultRuntimeSettings(): RuntimeSettings {
  return validateSettings({ site: { ...SITE }, homeSectionPageSize: HOME_SECTION_PAGE_SIZE });
}
export function settingsRevision(settings: RuntimeSettings): string {
  return createHash('sha256').update(JSON.stringify(validateSettings(settings))).digest('hex');
}
function snapshot(settings: RuntimeSettings, writable: boolean): SettingsSnapshot {
  return { ...settings, revision: settingsRevision(settings), writable };
}
function unavailable(error: unknown): never {
  if (error instanceof HttpError) throw error;
  throw new HttpError(503, 'SETTINGS_UNAVAILABLE', '配置服务暂不可用，请检查数据库连接与表结构。');
}
function decode(rows: { setting_key: string; payload: unknown }[]): RuntimeSettings {
  const settings = defaultRuntimeSettings();
  try {
    for (const row of rows) {
      if (!keys.includes(row.setting_key)) continue;
      const value: unknown = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
      if (row.setting_key === 'site') settings.site = readStoredSiteSettings(value);
      else settings.homeSectionPageSize = value as number;
    }
    return validateSettings(settings);
  } catch { throw new HttpError(503, 'SETTINGS_DATA_INVALID', '数据库配置格式无效，请修复配置数据。'); }
}
export function createSettingsStore(options: { getPool?: () => Pool; driver?: () => string } = {}): SettingsStore {
  const driver = options.driver ?? getStorageDriver;
  const db = options.getPool ?? getPool;
  async function readFrom(source: Pool | PoolConnection, lock = false): Promise<RuntimeSettings> {
    const [rows] = await source.query<RowDataPacket[]>(
      `SELECT setting_key, payload FROM nav_settings WHERE setting_key IN (?, ?) ORDER BY setting_key${lock ? ' FOR UPDATE' : ''}`, keys);
    return decode(rows as { setting_key: string; payload: unknown }[]);
  }
  return {
    async read() {
      if (driver() === 'seed') return snapshot(defaultRuntimeSettings(), false);
      try { return snapshot(await readFrom(db()), true); } catch (error) { return unavailable(error); }
    },
    async write(input) {
      const command = validateSettingsCommand(input);
      if (driver() === 'seed') throw new HttpError(503, 'SETTINGS_READ_ONLY', '种子模式配置只读，请启用 MySQL。');
      let connection: PoolConnection | undefined;
      let attempted = false; let transaction = false; let discard = false;
      try {
        connection = await db().getConnection();
        // 命名锁覆盖两键均不存在的首次保存；行锁和事务覆盖已有配置。
        attempted = true;
        const [locks] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lockName]);
        if (Number(locks[0]?.acquired) !== 1) throw new HttpError(409, 'SETTINGS_BUSY', '配置正在保存，请稍后重试。');
        await connection.beginTransaction(); transaction = true;
        const current = await readFrom(connection, true);
        if (settingsRevision(current) !== command.revision) throw new HttpError(409, 'SETTINGS_CONFLICT', '配置已更新，请重新加载后保存。');
        const next = validateSettings({ site: command.site, homeSectionPageSize: command.homeSectionPageSize });
        for (const key of keys as (keyof RuntimeSettings)[]) {
          await connection.execute('INSERT INTO nav_settings (setting_key, payload) VALUES (?, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)',
            [key, JSON.stringify(next[key])]);
        }
        await connection.commit(); transaction = false;
        return snapshot(next, true);
      } catch (error) {
        if (connection && transaction) try { await connection.rollback(); } catch { discard = true; }
        return unavailable(error);
      } finally {
        if (connection) {
          if (attempted) try {
            const [locks] = await connection.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lockName]);
            if (Number(locks[0]?.released) !== 1) discard = true;
          } catch { discard = true; }
          try { if (discard) connection.destroy(); else connection.release(); } catch { /* 清理不覆盖保存结果。 */ }
        }
      }
    },
  };
}
export const settingsStore = createSettingsStore();
/** 不缓存配置快照，提交成功后的下一次读取立即查询最新值。 */
export async function getRuntimeSettings(store: SettingsStore = settingsStore): Promise<RuntimeSettings> {
  const { site, homeSectionPageSize } = await store.read();
  return { site, homeSectionPageSize };
}
