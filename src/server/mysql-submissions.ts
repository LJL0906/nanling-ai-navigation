import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { writeSubmissionNotification } from './notifications-events.ts';
import { getMySqlOptions, getStorageDriver } from './database-config.ts';
import { HttpError } from './http.ts';
import { navigationCache } from './navigation-cache.ts';
import { parseRequestKey } from './submission-idempotency.ts';
import { submissionIdentity } from './submission-identity.ts';
import type { SiteSubmission } from './site-submissions.ts';

type Status = 'pending' | 'approved' | 'rejected';
type Upload = (data: string) => Promise<{ key: string; url: string }>;
export type UploadQuota = (connection: PoolConnection, clientAddress: string, bytes: number, upload: () => ReturnType<Upload>) => ReturnType<Upload>;
type Publisher = (connection: PoolConnection, record: Record<string, unknown>) => Promise<string>;
type ListOptions = { status: Status; page: number; pageSize: number; q?: string };
type Result = { id: string; status: 'pending' };
let pool: Pool | undefined;
export function getSubmissionPool(): Pool {
  if (getStorageDriver() !== 'mysql') throw new HttpError(503, 'SUBMISSIONS_STORAGE_READ_ONLY', '提交与通知需要 MySQL 持久化存储。');
  return pool ??= createPool({ ...getMySqlOptions(), timezone: 'Z' });
}
const unavailable = () => new HttpError(503, 'SUBMISSIONS_UNAVAILABLE', '提交服务暂时不可用，请稍后重试。');
function conflict(): never {
  throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '此 Idempotency-Key 已用于不同内容，请使用新 key。');
}
function decode(row: RowDataPacket): Record<string, unknown> {
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !['pending', 'approved', 'rejected'].includes(row.status)) throw unavailable();
  return { ...payload, userId: row.user_id ?? null, id: row.id, status: row.status,
    ...(row.published_site_id != null ? { publishedSiteId: row.published_site_id } : {}) };
}
const sqlDate = (date: string) => date.slice(0, 23).replace('T', ' ');

/** 独立工厂供 fake pool/publisher 注入；默认实例直到实际调用才读取连接选项。 */
export function createMySqlSubmissionRepository(options: {
  getPool?: () => Pool; publisher?: Publisher; uploadQuota?: UploadQuota;
} = {}) {
  const getPool = options.getPool ?? getSubmissionPool;
  const destroyed = new WeakSet<PoolConnection>();
  let quotaModule: typeof import('./upload-quota.ts') | undefined;
  const uploadQuota: UploadQuota = options.uploadQuota ?? (async (connection, address, bytes, upload) => {
    quotaModule ??= await import('./upload-quota.ts');
    return quotaModule.withUploadQuota(connection, address, bytes, upload);
  });
  const publish: Publisher = options.publisher ?? (async (connection, record) => {
    const { publishSubmission } = await import('./submission-publish.ts');
    return publishSubmission(connection, record);
  });

  // 命名锁属于连接而非事务；释放失败必须销毁，不能把带锁连接放回池。
  async function usingConnection<T>(lock: string | undefined, action: (c: PoolConnection) => Promise<T>): Promise<T> {
    let connection: PoolConnection | undefined;
    let lockAttempted = false;
    let discard = false;
    try {
      connection = await getPool().getConnection();
      if (lock) {
        lockAttempted = true;
        const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
        if (rows[0]?.acquired !== 1) throw unavailable();
      }
      return await action(connection);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw unavailable();
    } finally {
      if (connection && !destroyed.has(connection) && !quotaModule?.isUploadQuotaConnectionDestroyed(connection)) {
        if (lockAttempted) {
          try {
            const [rows] = await connection.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lock]);
            discard = rows[0]?.released !== 1;
          } catch { discard = true; }
        }
        try { if (discard) connection.destroy(); else connection.release(); }
        catch { /* 清理错误不泄露驱动信息，也不掩盖已提交结果。 */ }
      }
    }
  }
  async function transaction<T>(connection: PoolConnection, action: () => Promise<T>): Promise<T> {
    await connection.beginTransaction();
    try {
      const result = await action();
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); }
      catch { destroyed.add(connection); try { connection.destroy(); } catch { /* 不泄露清理异常 */ } }
      throw error;
    }
  }
  async function find(connection: PoolConnection, id: string, forUpdate = false) {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT * FROM nav_submissions WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0];
  }
  function replay(row: RowDataPacket, digest: string, userId: string | null): Result {
    if ((row.user_id ?? null) !== userId) conflict();
    if (row.request_digest == null) conflict();
    if (typeof row.request_digest !== 'string' || !/^[0-9a-f]{64}$/.test(row.request_digest)) throw unavailable();
    if (row.request_digest !== digest) conflict();
    return { id: row.id, status: 'pending' };
  }
  async function submitToMySql(data: SiteSubmission, key: string | undefined, upload: Upload, charge: () => void, clientAddress = '', userId: string | null = null): Promise<Result> {
    if (!userId) throw new HttpError(401, 'USER_UNAUTHORIZED', '新提交必须绑定已登录账号。');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(userId)) throw new HttpError(400, 'INVALID_USER_ID', '提交账号编号无效。');
    const { id, digest } = submissionIdentity(data, key, userId);
    return usingConnection(`nav-submit:${id}`, async connection => {
      const existing = await find(connection, id);
      if (existing) return replay(existing, digest, userId);
      charge();
      // 跨进程持锁完成上传。上传成功后进程崩溃/数据库回滚仍可能重传，不宣称跨 OSS exactly-once。
      // 不信任客户端文件大小；校验后的 Base64 实际解码长度用于服务端配额。
      const bytes = data.iconData ? Buffer.from(data.iconData.split(',')[1] ?? '', 'base64').length : 0;
      const icon = data.iconData ? await uploadQuota(connection, clientAddress, bytes, () => upload(data.iconData)) : undefined;
      const createdAt = new Date().toISOString();
      const payload = { ...data, ...(icon ? { iconData: '', iconUrl: icon.url,
        iconObject: { provider: 'oss', key: icon.key } } : {}), id, userId, status: 'pending', createdAt,
        ...(key ? { requestKey: id, requestDigest: digest } : {}) };
      try {
        return await transaction(connection, async () => {
          await connection.query(
            'INSERT INTO nav_submissions (id, request_digest, status, payload, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?)',
            [id, digest, 'pending', JSON.stringify(payload), sqlDate(createdAt), userId]);
          await writeSubmissionNotification(connection, userId, id, 'pending', data.name, data.url);
          return { id, status: 'pending' as const };
        });
      } catch (error) {
        if ((error as { code?: string })?.code === 'ER_DUP_ENTRY') {
          const winner = await find(connection, id);
          if (winner) return replay(winner, digest, userId);
        }
        throw error;
      }
    });
  }
  async function listMySqlSubmissions({ status, page, pageSize, q = '' }: ListOptions): Promise<{ items: Record<string, unknown>[]; total: number }> {
    if (!['pending', 'approved', 'rejected'].includes(status)) throw new HttpError(400, 'INVALID_STATUS', '筛选状态无效。');
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new HttpError(400, 'INVALID_PAGINATION', '分页参数无效。');
    }
    if (typeof q !== 'string' || q.trim().length > 100) {
      throw new HttpError(400, 'INVALID_QUERY', '站点名称搜索须为最多 100 字的字符串。');
    }
    q = q.trim();
    // LOCATE 将 % 和 _ 视为普通字符；显式转小写以支持 JSON 名称的不区分大小写匹配。
    const where = q ? "status = ? AND LOCATE(LOWER(?), LOWER(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.name')))) > 0" : 'status = ?';
    const filters = q ? [status, q] : [status];
    return usingConnection(undefined, async connection => {
      await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return transaction(connection, async () => {
        const [count] = await connection.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM nav_submissions WHERE ${where}`, filters);
        const [rows] = await connection.query<RowDataPacket[]>(
          `SELECT * FROM nav_submissions WHERE ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`,
          [...filters, pageSize, (page - 1) * pageSize]);
        const total = Number(count[0]?.total);
        if (!Number.isSafeInteger(total) || total < 0) throw unavailable();
        return { items: rows.map(decode), total };
      });
    });
  }
  async function reviewMySqlSubmission(id: string, status: 'approved' | 'rejected', reason: string, reviewedBy: string): Promise<Record<string, unknown>> {
    id = parseRequestKey(id)!;
    if (!['approved', 'rejected'].includes(status)) throw new HttpError(400, 'INVALID_STATUS', '审核状态无效。');
    // 理由及管理员字段由主模块校验和规范化。
    return usingConnection(status === 'approved' ? 'nav-submissions:publish' : undefined, async connection => {
      let published = false;
      const result = await transaction(connection, async () => {
        const row = await find(connection, id, true);
        if (!row) throw new HttpError(404, 'SUBMISSION_NOT_FOUND', '提交记录不存在。');
        const record = decode(row);
        if (row.status !== 'pending') {
          if (row.status === status && record.reviewReason === reason) return record;
          throw new HttpError(409, 'REVIEW_CONFLICT', '该提交已审核且与本次决策不同。');
        }
        const publishedSiteId = status === 'approved' ? await publish(connection, record) : null;
        if (status === 'approved' && (!publishedSiteId || publishedSiteId.length > 64)) throw unavailable();
        const reviewedAt = new Date().toISOString();
        const updated = { ...record, status, reviewReason: reason, reviewedBy, reviewedAt,
          ...(publishedSiteId ? { publishedSiteId } : {}) };
        await connection.query(
          'UPDATE nav_submissions SET status = ?, payload = ?, reviewed_at = ?, published_site_id = ? WHERE id = ?',
          [status, JSON.stringify(updated), sqlDate(reviewedAt), publishedSiteId, id]);
        await writeSubmissionNotification(connection, row.user_id, id, status, String(record.name ?? ''), String(record.url ?? ''), reason, publishedSiteId);
        published = publishedSiteId !== null;
        return updated;
      });
      // transaction 已成功 commit；回滚、拒绝和幂等重放均不失效。
      if (published) navigationCache.invalidate();
      return result;
    });
  }
  return { submitToMySql, listMySqlSubmissions, reviewMySqlSubmission };
}
const repository = createMySqlSubmissionRepository();
export const { submitToMySql, listMySqlSubmissions, reviewMySqlSubmission } = repository;


