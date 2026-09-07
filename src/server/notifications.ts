import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { getSubmissionPool } from './mysql-submissions.ts';
import { getStorageDriver } from './database-config.ts';
import { HttpError } from './http.ts';

export type NotificationKind = 'all' | 'site' | 'submission' | 'announcement';
export type NotificationQuery = { kind: NotificationKind; page: number; pageSize: number };
export function notificationQuery(params: URLSearchParams, admin = false): NotificationQuery {
  for (const key of params.keys()) {
    if (!(admin ? ['page', 'pageSize'] : ['kind', 'page', 'pageSize']).includes(key) || params.getAll(key).length !== 1) {
      throw new HttpError(400, 'INVALID_QUERY', '查询参数无效或重复。');
    }
  }
  const kind = admin ? 'announcement' : params.get('kind') ?? 'all';
  if (!['all', 'site', 'submission', 'announcement'].includes(kind)) throw new HttpError(400, 'INVALID_KIND', '通知类型无效。');
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) {
      throw new HttpError(400, 'INVALID_PAGINATION', '分页参数必须为范围内的正整数。');
    }
    return Number(raw);
  };
  return { kind: kind as NotificationKind, page: integer('page', 1, 1000000), pageSize: integer('pageSize', 20, 100) };
}
export function notificationScope(kind: NotificationKind, userId: string | null) {
  if (kind === 'submission' && !userId) throw new HttpError(401, 'USER_UNAUTHORIZED', '请先登录普通用户账号。');
  const publicScope = "(visibility = 'public' AND recipient_user_id IS NULL AND kind IN ('site','announcement'))";
  const privateScope = "(visibility = 'private' AND kind = 'submission' AND recipient_user_id = ?)";
  const values: string[] = [];
  let sql = publicScope;
  if (kind === 'submission') { sql = privateScope; values.push(userId!); }
  else if (kind === 'all' && userId) { sql = `(${publicScope} OR ${privateScope})`; values.push(userId); }
  if (kind !== 'all') { sql += ' AND kind = ?'; values.push(kind); }
  return { sql, values };
}
/** 使用 JSON 数组编码分隔字段，避免直接拼接歧义；不包含时间等易变字段。 */
export function announcementRevision(id: string, title: string, body: string): string {
  return createHash('sha256').update(JSON.stringify([id, title, body])).digest('hex');
}
function item(row: RowDataPacket) {
  const createdAt = row.created_at instanceof Date ? row.created_at.toISOString()
    : new Date(String(row.created_at).replace(' ', 'T').replace(/Z?$/, 'Z')).toISOString();
  return { id: row.id, kind: row.kind, title: row.title, body: row.body, createdAt,
    ...(row.kind === 'announcement' ? { revision: announcementRevision(row.id, row.title, row.body) } : {}),
    ...(row.status != null ? { status: row.status } : {}),
    // 审核理由和提交编号只允许出现在私人事件。
    ...(row.kind === 'submission' && row.reason != null ? { reason: row.reason } : {}),
    ...(row.site_id != null ? { siteId: row.site_id } : {}),
    ...(row.kind === 'submission' && row.submission_id != null ? { submissionId: row.submission_id } : {}) };
}
export function validateAnnouncement(value: unknown, method: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'INVALID_ANNOUNCEMENT', '公告须为 JSON 对象。');
  const input = value as Record<string, unknown>;
  const allowed = method === 'DELETE' ? ['id', 'revision'] : method === 'PUT' ? ['id', 'title', 'body', 'revision'] : ['id', 'title', 'body'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, 'INVALID_ANNOUNCEMENT', '公告包含未知字段。');
  const id = input.id;
  if ((method !== 'POST' || id !== undefined) && (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))) {
    throw new HttpError(400, 'INVALID_ANNOUNCEMENT', '公告编号无效。');
  }
  const revision = input.revision;
  if (method !== 'POST' && (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision))) {
    throw new HttpError(400, 'INVALID_REVISION', 'revision 必须为列表返回的 64 位小写十六进制 SHA-256 值，不接受 32 位版本。');
  }
  const text = (key: string, max: number) => {
    const v = input[key];
    if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(v)) {
      throw new HttpError(400, 'INVALID_ANNOUNCEMENT', `${key}须为 1–${max} 字的纯文本。`);
    }
    return v.trim();
  };
  return { id: typeof id === 'string' ? id : randomUUID(), revision, title: method === 'DELETE' ? '' : text('title', 200), body: method === 'DELETE' ? '' : text('body', 5000) };
}
export function createNotificationStore(options: { getPool?: () => Pool; driver?: () => string } = {}) {
  async function transaction<T>(action: (c: PoolConnection) => Promise<T>): Promise<T> {
    if ((options.driver ?? getStorageDriver)() !== 'mysql') throw new HttpError(503, 'NOTIFICATIONS_UNAVAILABLE', '通知需要 MySQL 存储，种子模式不支持持久化通知。');
    let c: PoolConnection | undefined; let discard = false;
    try {
      c = await (options.getPool ?? getSubmissionPool)().getConnection();
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.beginTransaction();
      try { const result = await action(c); await c.commit(); return result; }
      catch (e) { try { await c.rollback(); } catch { discard = true; } throw e; }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if ((e as {code?: string}).code === 'ER_DUP_ENTRY') throw new HttpError(409, 'ANNOUNCEMENT_CONFLICT', '公告编号已存在。');
      throw new HttpError(503, 'NOTIFICATIONS_UNAVAILABLE', '通知服务不可用，请检查数据库连接并执行通知增量迁移。');
    } finally { if (c) { try { if (discard) c.destroy(); else c.release(); } catch { /* 不覆盖结果 */ } } }
  }
  async function list(query: NotificationQuery, userId: string | null) {
    // 即便由内部调用也重新验证，避免非路由调用构造超大或负分页。
    const { kind, page, pageSize } = notificationQuery(new URLSearchParams({ kind: query.kind, page: String(query.page), pageSize: String(query.pageSize) }));
    const scope = notificationScope(kind, userId);
    return transaction(async c => {
      const [counts] = await c.query<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM nav_notifications WHERE ${scope.sql}`, scope.values);
      const [rows] = await c.query<RowDataPacket[]>(`SELECT id, kind, title, body, status, reason, site_id, submission_id, created_at
        FROM nav_notifications WHERE ${scope.sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, [...scope.values, pageSize, (page - 1) * pageSize]);
      const total = Number(counts[0]?.total);
      if (!Number.isSafeInteger(total) || total < 0) throw new HttpError(503, 'NOTIFICATIONS_UNAVAILABLE', '通知总数无效。');
      return { items: rows.map(item), total, page, pageSize };
    });
  }
  async function write(method: string, value: unknown) {
    if (!['POST', 'PUT', 'DELETE'].includes(method)) throw new HttpError(405, 'METHOD_NOT_ALLOWED', '公告操作无效。');
    const data = validateAnnouncement(value, method);
    return transaction(async c => {
      const readLocked = async () => {
        const [rows] = await c.query<RowDataPacket[]>("SELECT id, title, body FROM nav_notifications WHERE id = ? AND kind = 'announcement' AND visibility = 'public' AND recipient_user_id IS NULL FOR UPDATE", [data.id]);
        return rows[0];
      };
      if (method === 'POST') {
        // 先 INSERT，唯一键在并发重试时串行化；不对缺失行先加间隙锁。
        try {
          await c.query(`INSERT INTO nav_notifications (id,event_key,kind,visibility,recipient_user_id,title,body,status,created_at)
            VALUES (?,?,'announcement','public',NULL,?,?,'published',UTC_TIMESTAMP(3))`, [data.id, `announcement:${data.id}`, data.title, data.body]);
        } catch (error) {
          if ((error as { code?: string }).code !== 'ER_DUP_ENTRY') throw error;
          // 唯一键冲突不等于可重放：必须当前锁定读到公开公告且文本完全相同。
          const existing = await readLocked();
          if (!existing || existing.title !== data.title || existing.body !== data.body) {
            throw new HttpError(409, 'ANNOUNCEMENT_CONFLICT', '该公告编号已用于其他内容，未覆盖原记录。');
          }
        }
      } else {
        const existing = await readLocked();
        if (!existing) throw new HttpError(404, 'ANNOUNCEMENT_NOT_FOUND', '公告不存在。');
        if (announcementRevision(existing.id, existing.title, existing.body) !== data.revision) {
          throw new HttpError(409, 'ANNOUNCEMENT_CONFLICT', '公告已被修改，请刷新后重新确认，未覆盖或删除。');
        }
        if (method === 'DELETE') await c.query<ResultSetHeader>("DELETE FROM nav_notifications WHERE id = ? AND kind = 'announcement' AND visibility = 'public' AND recipient_user_id IS NULL", [data.id]);
        else await c.query("UPDATE nav_notifications SET title = ?, body = ? WHERE id = ? AND kind = 'announcement' AND visibility = 'public' AND recipient_user_id IS NULL", [data.title, data.body, data.id]);
      }
      return { id: data.id };
    });
  }
  return { list, write };
}
export const notificationStore = createNotificationStore();
