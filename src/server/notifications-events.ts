import type { PoolConnection } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';

/** 仅接受明确字段，绝不展开提交 payload；必须使用调用方事务连接。 */
export async function writeSiteNotification(c: PoolConnection, siteId: string, action: 'created' | 'deleted', siteName: string, siteUrl: string) {
  await c.query(`INSERT INTO nav_notifications
    (id, event_key, kind, visibility, recipient_user_id, title, body, status, site_id, created_at)
    VALUES (?, ?, 'site', 'public', NULL, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
  [randomUUID(), `site:${action}:${siteId}`, action === 'created' ? '新增站点' : '站点已删除',
    `${action === 'created' ? '已收录' : '已移除'}站点：${siteName}\n${siteUrl}`, action, siteId]);
}
export async function writeSubmissionNotification(c: PoolConnection, owner: string | null | undefined,
  submissionId: string, status: 'pending' | 'approved' | 'rejected', siteName: string, siteUrl: string, reason = '', siteId: string | null = null) {
  // 历史匿名无可验证 owner，不猜测、不生成可被其他账号认领的事件。
  if (!owner) return;
  const title = { pending: '提交成功', approved: '提交审核通过', rejected: '提交被驳回' }[status];
  await c.query(`INSERT INTO nav_notifications
    (id, event_key, kind, visibility, recipient_user_id, title, body, status, reason, site_id, submission_id, created_at)
    VALUES (?, ?, 'submission', 'private', ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
  [randomUUID(), `submission:${submissionId}:${status}`, owner, title,
    `${status === 'pending' ? '已保存提交，等待审核' : title}：${siteName}\n${siteUrl}`,
    status, reason || null, siteId, submissionId]);
}
