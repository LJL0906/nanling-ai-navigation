import { writeSiteNotification } from './notifications-events.ts';
import { randomUUID } from 'node:crypto';
import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { getMySqlOptions, getStorageDriver } from './database-config.ts';
import { HttpError } from './http.ts';
import { contentRevision, contentUrlKey, type ContentCommand, type ContentKind } from './content-validation.ts';
import { navigationCache } from './navigation-cache.ts';

type Row = { id: string; slug: string; sort_order: number; category_id?: string; payload: unknown };
type Item = Record<string, unknown> & { id: string; slug: string; revision: string };
let pool: Pool | undefined;
const getPool = () => pool ??= createPool(getMySqlOptions());
function payload(row: { payload: unknown }): Record<string, unknown> {
  const value = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(503, 'CONTENT_DATA_INVALID', '内容数据异常，请检查数据库。');
  return value as Record<string, unknown>;
}
function item(row: Row, kind: ContentKind): Item {
  const value = { ...payload(row), id: row.id, slug: row.slug,
    ...(kind === 'sites' ? { category: row.category_id, sortOrder: row.sort_order } : { order: row.sort_order }) };
  return { ...value, revision: contentRevision(value) };
}
function failure(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }

/** 维护旧精选重定向：新增或移动不能占用其他站点仍在使用的旧路径。 */
function checkSiteRoutes(categories: Row[], sites: Row[]): void {
  const slugs = new Map(categories.map(row => [row.id, row.slug]));
  const paths = new Set(sites.map(row => `/${slugs.get(row.category_id!)}/${row.slug}/`));
  const redirects = new Map<string, string>();
  for (const row of sites) {
    const to = `/${slugs.get(row.category_id!)}/${row.slug}/`;
    const sources = payload(row).sources;
    if (!Array.isArray(sources)) continue;
    for (const source of sources) {
      if (source?.dataset !== 'sites.json') continue;
      const from = `/${source.recordId}/`;
      if (from === to) continue;
      if (paths.has(from) || redirects.has(from) && redirects.get(from) !== to) {
        failure(409, 'SITE_ROUTE_CONFLICT', '路径与已有站点的历史访问链接冲突，请使用其他路径标识或分类。');
      }
      redirects.set(from, to);
    }
  }
}

/** 与审核发布共用命名锁；分类同时持有菜单写锁，避免删除与菜单保存交错。 */
export function createContentStore(options: { getPool?: () => Pool; driver?: () => string; invalidate?: () => void } = {}) {
  const driver = options.driver ?? getStorageDriver;
  const invalidate = options.invalidate ?? (() => navigationCache.invalidate());
  async function connection<T>(locks: string[], action: (c: PoolConnection) => Promise<T>): Promise<T> {
    let c: PoolConnection | undefined; const attempted: string[] = []; let discard = false;
    try {
      c = await (options.getPool ?? getPool)().getConnection();
      for (const lock of locks) {
        attempted.push(lock);
        const [rows] = await c.query<RowDataPacket[]>('SELECT GET_LOCK(?, 10) AS acquired', [lock]);
        if (Number(rows[0]?.acquired) !== 1) failure(409, 'CONTENT_BUSY', '其他操作正在保存，请稍后重试。');
      }
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      await c.beginTransaction();
      try {
        const result = await action(c);
        await c.commit();
        return result;
      } catch (error) {
        try { await c.rollback(); } catch { discard = true; }
        throw error;
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const code = (error as { code?: string }).code;
      if (['ER_DUP_ENTRY', 'ER_ROW_IS_REFERENCED_2', 'ER_NO_REFERENCED_ROW_2', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code ?? '')) {
        failure(409, 'CONTENT_CONFLICT', '内容重复、仍有关联或正在被其他操作修改，请刷新后重试。');
      }
      return failure(503, 'CONTENT_UNAVAILABLE', '内容服务暂不可用，请检查数据库连接与表结构。');
    } finally {
      if (c) {
        for (const lock of attempted.reverse()) {
          try {
            const [rows] = await c.query<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', [lock]);
            if (Number(rows[0]?.released) !== 1) discard = true;
          } catch { discard = true; }
        }
        try { if (discard) c.destroy(); else c.release(); } catch { /* 清理异常不覆盖操作结果。 */ }
      }
    }
  }
  async function rows(c: PoolConnection, kind: ContentKind, lock = false): Promise<Row[]> {
    const table = kind === 'sites' ? 'nav_sites' : 'nav_categories';
    const [result] = await c.query<RowDataPacket[]>(`SELECT * FROM ${table} ORDER BY sort_order, id${lock ? ' FOR UPDATE' : ''}`);
    return result as unknown as Row[];
  }
  async function list(kind: ContentKind) {
    if (driver() !== 'mysql') {
      const { default: seed } = await import('../data/导航数据.json', { with: { type: 'json' } });
      const items = seed[kind].map((value, index) => {
        const data = kind === 'sites' ? { ...value, sortOrder: index } : value;
        return { ...data, revision: contentRevision(data) };
      });
      return { items, writable: false };
    }
    return connection([], async c => {
      const values = await rows(c, kind);
      const sites = kind === 'categories' ? await rows(c, 'sites') : [];
      return { items: values.map(row => ({ ...item(row, kind), ...(kind === 'categories' ? { count: sites.filter(site => site.category_id === row.id).length } : {}) })), writable: true };
    });
  }
  async function write(method: string, command: ContentCommand) {
    if (driver() !== 'mysql') failure(503, 'CONTENT_READ_ONLY', '种子数据只读，请切换 MySQL 后再维护内容。');
    const locks = ['nav-submissions:publish', ...(command.kind === 'categories' ? ['nanling_menu_initial_import'] : [])];
    const result = await connection(locks, async c => {
      const categories = await rows(c, 'categories', true);
      const sites = await rows(c, 'sites', true);
      const collection = command.kind === 'sites' ? sites : categories;
      const existing = method === 'POST' ? undefined : collection.find(row => row.id === command.id);
      if (method !== 'POST') {
        if (!existing) failure(404, 'CONTENT_NOT_FOUND', '记录已不存在，请刷新列表。');
        if (item(existing, command.kind).revision !== command.revision) failure(409, 'CONTENT_CONFLICT', '记录已被其他操作修改，请刷新后重新编辑。');
      }
      const id = existing?.id ?? `${command.kind === 'sites' ? 'site' : 'category'}-${randomUUID()}`;
      if (method === 'DELETE') {
        if (collection.length <= 1) failure(409, 'CONTENT_LAST_RECORD', '至少保留一个分类和一个站点，不能删除最后一条记录。');
        if (command.kind === 'categories') {
          if (sites.some(site => site.category_id === id)) failure(409, 'CATEGORY_IN_USE', '分类下仍有站点，请先移动或删除这些站点。');
          const [menus] = await c.query<RowDataPacket[]>('SELECT href, payload FROM nav_menus FOR UPDATE');
          const slug = existing!.slug;
          if (menus.some(menu => {
            const data = payload({ payload: menu.payload });
            return data.homeAnchor === slug || data.categoryPath === `/${slug}/` || menu.href === `/#${slug}` || typeof menu.href === 'string' && new RegExp(`^/${slug}(?:/|[?#]|$)`).test(menu.href);
          })) failure(409, 'CATEGORY_MENU_REFERENCE', '菜单仍引用该分类，请先在菜单管理中调整关联。');
          const [submissions] = await c.query<RowDataPacket[]>("SELECT payload FROM nav_submissions WHERE status = 'pending' FOR UPDATE");
          if (submissions.some(record => payload({ payload: record.payload }).categoryId === id)) failure(409, 'CATEGORY_PENDING_REVIEW', '该分类还有待审批提交，请先处理审批。');
        }
        if (command.kind === 'sites') {
          await c.execute('DELETE FROM nav_user_records WHERE site_id = ?', [id]);
          await writeSiteNotification(c, id, 'deleted', String(payload(existing!).name ?? ''), String(payload(existing!).url ?? ''));
        }
        await c.execute(`DELETE FROM ${command.kind === 'sites' ? 'nav_sites' : 'nav_categories'} WHERE id = ?`, [id]);
        return { id };
      }
      const input = command.item!;
      if (existing && input.slug !== existing.slug) failure(409, 'CONTENT_SLUG_IMMUTABLE', '已有路径标识不可修改，避免破坏访问链接。');
      if (command.kind === 'categories') {
        if (categories.some(row => row.id !== id && (row.slug === input.slug || String(payload(row).name).toLocaleLowerCase() === String(input.name).toLocaleLowerCase()))) {
          failure(409, 'CATEGORY_DUPLICATE', '分类名称或路径标识已存在。');
        }
        const value = { ...(existing ? payload(existing) : {}), ...input, id, count: 0 };
        if (existing) await c.execute('UPDATE nav_categories SET sort_order = ?, payload = ? WHERE id = ?', [Number(input.order), JSON.stringify(value), id]);
        else await c.execute('INSERT INTO nav_categories (id, slug, sort_order, payload) VALUES (?, ?, ?, ?)', [id, String(input.slug), Number(input.order), JSON.stringify(value)]);
      } else {
        if (!categories.some(row => row.id === input.category)) failure(409, 'CATEGORY_NOT_FOUND', '所属分类已不存在，请刷新分类列表。');
        const url = String(input.url); const key = contentUrlKey(url);
        if (sites.some(row => row.id !== id && [payload(row).url, ...(Array.isArray(payload(row).alternateUrls) ? payload(row).alternateUrls as string[] : [])].some(address => contentUrlKey(String(address)) === key))) {
          failure(409, 'SITE_URL_DUPLICATE', '站点地址已收录，请编辑已有站点。');
        }
        if (sites.some(row => row.id !== id && row.category_id === input.category && row.slug === input.slug)) failure(409, 'SITE_SLUG_DUPLICATE', '目标分类已有相同路径标识的站点。');
        const previous = existing ? payload(existing) : { aliases: [], alternateUrls: [], sourceCategories: [], sources: [], icon: null, verification: { status: 'unverified', checkedAt: null } };
        const { sortOrder, ...fields } = input;
        const value = { ...previous, ...fields, id, domain: new URL(url).hostname,
          ...(existing && previous.url !== url ? { verification: { status: 'unverified', checkedAt: null } } : {}) };
        checkSiteRoutes(categories, [...sites.filter(row => row.id !== id), { id, slug: String(input.slug), category_id: String(input.category), sort_order: Number(sortOrder), payload: value }]);
        if (existing) await c.execute('UPDATE nav_sites SET category_id = ?, sort_order = ?, payload = ? WHERE id = ?', [String(input.category), Number(sortOrder), JSON.stringify(value), id]);
        else await c.execute('INSERT INTO nav_sites (id, category_id, slug, sort_order, payload) VALUES (?, ?, ?, ?, ?)', [id, String(input.category), String(input.slug), Number(sortOrder), JSON.stringify(value)]);
      }
      if (command.kind === 'sites' && method === 'POST') await writeSiteNotification(c, id, 'created', String(input.name), String(input.url));
      return { id };
    });
    invalidate();
    return result;
  }
  return { list, write };
}
export const contentStore = createContentStore();
