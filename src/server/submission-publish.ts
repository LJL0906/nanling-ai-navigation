import { writeSiteNotification } from './notifications-events.ts';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { UnifiedCategory, UnifiedSite } from '../lib/navigation-types.ts';
import { HttpError } from './http.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
function payload(row: RowDataPacket): Record<string, unknown> {
  let value: unknown = row.payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return fail(503, 'DATABASE_DATA_INVALID', '导航数据无效。'); }
  }
  if (!object(value)) return fail(503, 'DATABASE_DATA_INVALID', '导航数据无效。');
  return value;
}
function text(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return fail(400, 'INVALID_SUBMISSION', '提交字段格式无效。');
  return value.trim();
}
function httpUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url;
  } catch { /* 统一返回公开错误。 */ }
  return fail(400, 'INVALID_SUBMISSION_URL', '站点地址必须为有效的 HTTP(S) 地址。');
}
/** URL 自动规范主机大小写、默认端口；忽略片段、路径尾斜杠，不误合并大小写不同的路径/查询。 */
function urlKey(value: string): string {
  const url = httpUrl(value);
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}
function nextOrder(rows: RowDataPacket[], field: 'category' | 'site'): number {
  let max = -1;
  for (const row of rows) {
    const order = field === 'category' ? payload(row).order : row.sort_order;
    if (!Number.isSafeInteger(order) || Number(order) < 0 || Number(order) >= 2147483647) {
      return fail(503, 'DATABASE_DATA_INVALID', '导航排序数据无效或已超出范围。');
    }
    max = Math.max(max, Number(order));
  }
  return max + 1;
}

/**
 * 调用方必须已开启 InnoDB 事务并锁住提交行；负责 commit/rollback 和死锁重试。
 * 调用方必须在本连接上成功取得 GET_LOCK('nav-submissions:publish', 10)，
 * 并持有该 DB 命名锁直至 commit/rollback 完成，再于 finally 中释放。
 * 本 helper 不获取或释放命名锁；所有提交发布及外部相关写入均须遵循该锁。
 * 锁后使用 FOR UPDATE 当前读，避免 REPEATABLE READ 的旧快照漏掉刚发布的数据。
 * icon URL 仅存为来源（适配后 sourceIcon），现有适配层仍只加载本地白名单图标；
 * 不获取远程资源、不转换 iconObject 私有 OSS key，不公开 remark 或其他提交私有字段。
 */
export async function publishSubmission(connection: PoolConnection, record: Record<string, unknown>): Promise<string> {
  const id = text(record, 'id');
  const name = text(record, 'name');
  const originalUrl = text(record, 'url');
  const categoryId = text(record, 'categoryId');
  const customCategory = text(record, 'customCategory');
  if (!UUID.test(id) || !name || Boolean(categoryId) === Boolean(customCategory)
    || customCategory.length > 50 || /[\x00-\x1f\x7f]/u.test(customCategory)) {
    return fail(400, 'INVALID_SUBMISSION', '提交编号、名称或分类无效。');
  }
  const url = httpUrl(originalUrl);
  const key = urlKey(originalUrl);
  const iconUrl = text(record, 'iconUrl');
  if (iconUrl) httpUrl(iconUrl);
  const siteId = `submitted-${id}`;

  const [categories] = await connection.execute<RowDataPacket[]>(
    'SELECT id, slug, sort_order, payload FROM nav_categories ORDER BY id FOR UPDATE',
  );
  let category = categories.find(row => categoryId ? row.id === categoryId : payload(row).name === customCategory);
  if (categoryId && !category) return fail(400, 'INVALID_SUBMISSION_CATEGORY', '所选分类不存在。');

  const [sites] = await connection.execute<RowDataPacket[]>(
    'SELECT id, category_id, slug, sort_order, payload FROM nav_sites ORDER BY id FOR UPDATE',
  );
  let published: string | undefined;
  for (const row of sites) {
    const data = payload(row);
    const ownSource = Array.isArray(data.sources) && data.sources.some(source =>
      object(source) && source.dataset === 'submission' && source.recordId === id);
    const sameUrl = typeof data.url === 'string' && urlKey(data.url) === key;
    if ((row.id === siteId || ownSource) && !sameUrl) {
      return fail(409, 'SUBMISSION_PUBLISH_CONFLICT', '该提交已发布为其他地址。');
    }
    if ((sameUrl || row.id === siteId) && !ownSource) {
      return fail(409, 'SUBMISSION_URL_EXISTS', '该站点地址或发布编号已存在。');
    }
    if (sameUrl && ownSource) published = String(row.id);
  }
  if (published) return published;

  // 先完成冲突检查和排序校验，避免错误路径不必要地创建分类。
  const siteOrder = nextOrder(sites, 'site');
  if (!category) {
    const categoryPayload: UnifiedCategory = {
      id: siteId, slug: siteId, name: customCategory, color: '#3777f5',
      icon: 'lucide:folder', order: nextOrder(categories, 'category'), count: 0,
    };
    if (categories.some(row => row.id === siteId || row.slug === siteId)) {
      return fail(409, 'SUBMISSION_CATEGORY_CONFLICT', '自动分类编号已被占用。');
    }
    await connection.execute(
      'INSERT INTO nav_categories (id, slug, sort_order, payload) VALUES (?, ?, ?, ?)',
      [siteId, siteId, categoryPayload.order, JSON.stringify(categoryPayload)],
    );
    category = { id: siteId, payload: categoryPayload } as RowDataPacket;
  }
  const categoryName = payload(category).name;
  const site: UnifiedSite = {
    id: siteId, slug: siteId, name, url: url.href, domain: url.hostname,
    description: `${name}，相关网站与资源。`, category: String(category.id),
    aliases: [], alternateUrls: [], sourceCategories: typeof categoryName === 'string' ? [categoryName] : [], tags: [],
    icon: iconUrl ? { type: 'url', value: iconUrl } : null,
    sources: [{ dataset: 'submission', recordId: id, category: typeof categoryName === 'string' ? categoryName : null,
      subcategory: null, detailUrl: null, originalUrl }],
    verification: { status: 'unverified', checkedAt: null },
  };
  await connection.execute(
    'INSERT INTO nav_sites (id, category_id, slug, sort_order, payload) VALUES (?, ?, ?, ?, ?)',
    [site.id, site.category, site.slug, siteOrder, JSON.stringify(site)],
  );
  await writeSiteNotification(connection, siteId, 'created', name, url.href);
  return siteId;
}
