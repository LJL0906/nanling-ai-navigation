import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { HttpError } from './http.ts';

type Environment = Readonly<Record<string, string | undefined>>;
export interface UploadQuotaOptions { env?: Environment }
const MiB = 1024 * 1024;
const TOTAL_PERIOD = '1970-01-01';
const SLOT_NAMES = ['nav-upload:slot:0', 'nav-upload:slot:1'] as const;
const destroyed = new WeakSet<PoolConnection>();
const active = new WeakSet<PoolConnection>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const TOTAL_SCOPE = `global:${digest('total')}`;
const DAILY_SCOPE = `global:${digest('daily')}`;

/** SHA256 不是强匿名：IP 空间可枚举；不应公开此表或将其写入日志。 */
export function uploadQuotaIpScope(address: string): string {
  let normalized = 'unknown';
  if (typeof address === 'string' && !address.includes('%')) {
    const version = isIP(address);
    if (version === 4) normalized = address;
    if (version === 6) {
      normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
      const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(normalized);
      if (mapped) {
        const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
        normalized = [high >>> 8, high & 255, low >>> 8, low & 255].join('.');
      }
    }
  }
  return `ip:${digest(normalized)}`;
}

/** 外层仓储 finally 必须检查：true 时跳过 RELEASE_LOCK 和 connection.release()。 */
export function isUploadQuotaConnectionDestroyed(connection: PoolConnection): boolean {
  return destroyed.has(connection);
}

function discard(connection: PoolConnection): void {
  if (destroyed.has(connection)) return;
  destroyed.add(connection);
  try { connection.destroy(); } catch { /* 不泄漏驱动清理异常；禁止重新入池。 */ }
}
function unavailable(): HttpError {
  return new HttpError(503, 'UPLOAD_QUOTA_UNAVAILABLE', '上传配额服务暂不可用。');
}
function configuration(): never {
  throw new HttpError(503, 'UPLOAD_QUOTA_CONFIGURATION', '上传配额配置无效。');
}
function readConfig(env: Environment) {
  if (env.OSS_UPLOAD_ENABLED === 'false') {
    throw new HttpError(503, 'UPLOAD_DISABLED', '附件上传已停用。');
  }
  if (env.OSS_UPLOAD_ENABLED !== undefined && env.OSS_UPLOAD_ENABLED !== 'true') configuration();
  const positive = (name: string, fallback: number, max: number): bigint => {
    const raw = env[name];
    if (raw === undefined) return BigInt(fallback);
    if (!/^[1-9]\d{0,15}$/.test(raw)) configuration();
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value > max) configuration();
    return BigInt(value);
  };
  // 配置上限：次数 100 万，字节 1 TiB；不支持放大固定的两个并发槽位。
  const count = (name: string, fallback: number) => positive(name, fallback, 1_000_000);
  const bytes = (name: string, fallback: number) => positive(name, fallback, 1024 ** 4);
  return {
    total: [count('OSS_UPLOAD_TOTAL_LIMIT', 2000), bytes('OSS_UPLOAD_TOTAL_BYTES', 1024 * MiB)],
    daily: [count('OSS_UPLOAD_DAILY_LIMIT', 200), bytes('OSS_UPLOAD_DAILY_BYTES', 100 * MiB)],
    ip: [count('OSS_UPLOAD_IP_DAILY_LIMIT', 10), bytes('OSS_UPLOAD_IP_DAILY_BYTES', 5 * MiB)],
  };
}

async function acquireSlot(connection: PoolConnection): Promise<string> {
  for (const slot of SLOT_NAMES) {
    try {
      const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT GET_LOCK(?, 0) AS acquired', [slot]);
      if (rows[0]?.acquired === 1) return slot;
      if (rows[0]?.acquired !== 0) throw unavailable();
    } catch {
      // GET_LOCK 结果不明时也可能已经持锁，必须断开连接。
      discard(connection);
      throw unavailable();
    }
  }
  throw new HttpError(429, 'UPLOAD_BUSY', '上传繁忙，请稍后重试。');
}

async function charge(connection: PoolConnection, scope: string, size: number,
  config: ReturnType<typeof readConfig>): Promise<void> {
  const denied = new HttpError(429, 'UPLOAD_LIMIT_REACHED', '上传配额已用尽。');
  const pending: [string, string][] = [];
  const integer = (value: unknown): bigint => {
    // SQL 显式返回字符串，避免 mysql2 BIGINT 到 number 的精度损失。
    if (typeof value !== 'string' || !/^\d+$/.test(value)) throw unavailable();
    return BigInt(value);
  };
  const check = async (key: string, period: string, limits: bigint[]) => {
    await connection.query(
      'INSERT IGNORE INTO nav_upload_quotas (scope, period, attempts, bytes) VALUES (?, ?, 0, 0)',
      [key, period]);
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT CAST(attempts AS CHAR) AS attempts, CAST(bytes AS CHAR) AS bytes
       FROM nav_upload_quotas WHERE scope = ? AND period = ? FOR UPDATE`, [key, period]);
    if (rows.length !== 1) throw unavailable();
    if (integer(rows[0].attempts) + 1n > limits[0]
      || integer(rows[0].bytes) + BigInt(size) > limits[1]) throw denied;
    pending.push([key, period]);
  };
  try {
    await connection.beginTransaction();
    // 全局 total 行同时序列化所有计费；先检查全局，避免无限 IP 新建行。
    await check(TOTAL_SCOPE, TOTAL_PERIOD, config.total);
    const [dates] = await connection.query<RowDataPacket[]>(
      "SELECT DATE_FORMAT(UTC_DATE(), '%Y-%m-%d') AS period");
    const period: unknown = dates[0]?.period;
    if (typeof period !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(period)
      || period <= TOTAL_PERIOD) throw unavailable();
    // 本次计费只取一次数据库 UTC 日，避免跨午夜分裂两个 daily 桶。
    await check(DAILY_SCOPE, period, config.daily);
    await check(scope, period, config.ip);
    for (const [key, day] of pending) {
      const [result] = await connection.query<ResultSetHeader>(
        `UPDATE nav_upload_quotas SET attempts = attempts + 1, bytes = bytes + ?
         WHERE scope = ? AND period = ?`, [size, key, day]);
      if (result.affectedRows !== 1) throw unavailable();
    }
    await connection.commit();
  } catch (error) {
    try { await connection.rollback(); } catch {
      discard(connection);
      throw unavailable();
    }
    if (error === denied) throw denied;
    // 含 commit 应答丢失：不上传、不重试、不退款，不把原始异常作为 cause。
    discard(connection);
    throw unavailable();
  }
}

/**
 * 集成契约：调用方已排除幂等重放、持有提交幂等锁，但尚未开启事务。
 * bytes 必须取自严格校验并解码后的实际 Buffer.byteLength，不能用请求头、
 * base64 长度或客户端声明值；此 number 接口无法自行核验 upload 闭包中的内容。
 * 本函数不读取请求头、不读 .env、不获取/归还池连接；成功计费后才调用 upload。
 * OSS 失败/结果不明保持计费，OSS 适配器负责其自身错误脱敏。
 * finally 释放异常优先安全上抛 503（即使 OSS 已成功），连接会被销毁。
 * 外层必须用 isUploadQuotaConnectionDestroyed 跳过死连接的解锁和 release。
 * 同一连接不能并行/递归使用本函数；所有进程须连同一个 MySQL 写入实例。
 */
export async function withUploadQuota<T>(connection: PoolConnection, clientAddress: string,
  bytes: number, upload: () => Promise<T>, options: UploadQuotaOptions = {}): Promise<T> {
  const config = readConfig(options.env ?? process.env);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes >= MiB) configuration();
  if (destroyed.has(connection)) throw unavailable();
  if (active.has(connection)) throw new HttpError(429, 'UPLOAD_BUSY', '上传繁忙，请稍后重试。');
  active.add(connection);
  let slot: string | undefined;
  try {
    slot = await acquireSlot(connection);
    await charge(connection, uploadQuotaIpScope(clientAddress), bytes, config);
    return await upload();
  } finally {
    try {
      if (slot && !destroyed.has(connection)) {
        try {
          const [rows] = await connection.query<RowDataPacket[]>(
            'SELECT RELEASE_LOCK(?) AS released', [slot]);
          if (rows[0]?.released !== 1) throw unavailable();
        } catch {
          discard(connection);
          throw unavailable();
        }
      }
    } finally { active.delete(connection); }
  }
}

/** 测试/依赖注入工厂；仍然使用调用方传入的同一连接，绝不另取连接。 */
export function createUploadQuota(options: UploadQuotaOptions = {}) {
  return <T>(connection: PoolConnection, address: string, bytes: number, upload: () => Promise<T>) =>
    withUploadQuota(connection, address, bytes, upload, options);
}
