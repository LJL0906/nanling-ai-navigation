/** 浏览器只接收可展示字段，不渲染服务端内容中的 HTML。 */
export const notificationKinds = ['site', 'submission', 'announcement'] as const;
export type NotificationKind = typeof notificationKinds[number];
export interface NotificationItem {
  id: string; kind: NotificationKind; title: string; body: string; createdAt: string;
  status?: string; reason?: string; siteId?: string; submissionId?: string; revision?: string;
}
export interface NotificationPage { items: NotificationItem[]; total: number; page: number; pageSize: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseNotificationPage(value: unknown): NotificationPage {
  if (!object(value) || !Array.isArray(value.items) || !Number.isSafeInteger(value.total) || Number(value.total) < 0
    || !Number.isSafeInteger(value.page) || Number(value.page) < 1 || !Number.isSafeInteger(value.pageSize) || Number(value.pageSize) < 1
    || value.items.length > Number(value.pageSize)) throw new Error('消息响应格式异常，请重试。');
  const items = value.items.map((item): NotificationItem => {
    if (!object(item) || typeof item.id !== 'string' || !item.id || !notificationKinds.includes(item.kind as NotificationKind)
      || typeof item.title !== 'string' || typeof item.body !== 'string' || typeof item.createdAt !== 'string'
      || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('消息内容格式异常，请重试。');
    for (const key of ['status', 'reason', 'siteId', 'submissionId', 'revision']) {
      if (item[key] != null && typeof item[key] !== 'string') throw new Error('消息内容格式异常，请重试。');
    }
    return { id: item.id, kind: item.kind as NotificationKind, title: item.title, body: item.body, createdAt: item.createdAt,
      ...(typeof item.status === 'string' ? { status: item.status } : {}),
      ...(typeof item.revision === 'string' ? { revision: item.revision } : {}),
      ...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
      ...(typeof item.siteId === 'string' ? { siteId: item.siteId } : {}),
      ...(typeof item.submissionId === 'string' ? { submissionId: item.submissionId } : {}) };
  });
  return { items, total: Number(value.total), page: Number(value.page), pageSize: Number(value.pageSize) };
}
export function notificationStatus(value: string | undefined): string {
  return ({ pending: '待审核', approved: '审核通过', rejected: '已驳回', created: '新增站点', added: '新增站点', deleted: '站点已删除', published: '已发布' } as Record<string, string>)[value ?? ''] ?? '';
}
