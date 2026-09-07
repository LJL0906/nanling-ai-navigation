import { isValidSiteId } from '../lib/site-id.ts';
import { createPersonalStore, PERSONAL_KEYS } from '../lib/personal-store.ts';
import type { PersonalKind, PersonalRecord, StoragePort, VisitType } from '../lib/personal-store.ts';

export interface PersonalData { favorites: PersonalRecord[]; history: PersonalRecord[]; }
export type PersonalAction =
  | { action: 'favorite'; siteId: string; selected: boolean }
  | { action: 'visit'; siteId: string; visitType: VisitType }
  | { action: 'remove'; kind: PersonalKind; siteId: string }
  | { action: 'clear'; kind: PersonalKind }
  | { action: 'import'; favorites: PersonalRecord[]; history: PersonalRecord[] };
export class LoginRequiredError extends Error {
  constructor() { super('请先登录后管理收藏和访问记录'); }
}
export function requestPersonalAuth(reason: 'favorite' | 'personal') {
  document.dispatchEvent(new CustomEvent('nav:auth-required', { detail: { reason } }));
}

const validRecords = (items: unknown): items is PersonalRecord[] => Array.isArray(items) && items.every((item) =>
  item && isValidSiteId(item.siteId)
  && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt))
  && (item.visitType === undefined || item.visitType === 'detail' || item.visitType === 'external'));

/** 所有读取、迁移与写入共用队列，不持久化服务端快照。 */
export function createPersonalApi(options: {
  fetch: typeof fetch;
  storage: StoragePort & { removeItem(key: string): void };
  changed?: () => void;
  broadcast?: () => void;
}) {
  const legacy = createPersonalStore(options.storage);
  let data: PersonalData = { favorites: [], history: [] };
  let status: 'idle' | 'loading' | 'ready' | 'signed-out' | 'error' = 'idle';
  let error = '';
  let warning = '';
  let pending = 0;
  let initialized = false;
  let queue: Promise<unknown> = Promise.resolve();
  const changed = () => options.changed?.();
  const snapshot = () => ({ data, status, error, warning, pending });

  async function request(action?: PersonalAction): Promise<PersonalData> {
    // 大批量迁移可能超过浏览器 keepalive 64 KiB 限额；仅GET和小操作启用。
    const response = await options.fetch('/api/personal', {
      method: action ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', keepalive: action?.action !== 'import',
      ...(action ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) } : {}),
    });
    if (response.status === 401) {
      data = { favorites: [], history: [] };
      status = 'signed-out';
      warning = '';
      initialized = false;
      throw new LoginRequiredError();
    }
    if (!response.ok) throw new Error(`个人数据请求失败（${response.status}），请重试`);
    const body = await response.json();
    if (!body?.data || !validRecords(body.data.favorites) || !validRecords(body.data.history)) {
      throw new Error('个人数据响应格式错误，请重试');
    }
    return { favorites: body.data.favorites, history: body.data.history };
  }

  async function migrateLegacy() {
    let originals: Record<string, string | null>;
    let favorites: PersonalRecord[];
    let history: PersonalRecord[];
    try {
      originals = Object.fromEntries(Object.entries(PERSONAL_KEYS)
        .map(([kind, key]) => [kind, options.storage.getItem(key)]));
      for (const raw of Object.values(originals)) {
        if (raw === null) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new Error('本地旧记录格式错误'); }
        if (!validRecords(parsed)) throw new Error('本地旧记录字段无效');
      }
      favorites = legacy.read('favorites');
      history = legacy.read('history');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法读取浏览器存储';
      warning = `旧记录迁移已跳过：${message}。未删除本地原数据，账号数据库仍可正常使用。`;
      return;
    }
    if (!Object.values(originals).some((value) => value !== null)) return;
    data = await request({ action: 'import', favorites, history });
    options.broadcast?.();
    try {
      for (const kind of ['favorites', 'history'] as const) {
        // 另一标签页可能刚更新旧记录，不能删掉未导入的数据。
        if (options.storage.getItem(PERSONAL_KEYS[kind]) === originals[kind]) {
          options.storage.removeItem(PERSONAL_KEYS[kind]);
        }
      }
    } catch {
      warning = '旧记录已导入数据库，但本地旧键清理失败；未清理的数据仍保留，账号数据库可正常使用。';
    }
  }

  async function initialize() {
    status = 'loading';
    warning = '';
    changed();
    data = await request();
    // GET 成功才尝试迁移；本地读取/格式/清理问题不阻断服务器功能。
    await migrateLegacy();
    initialized = true;
    status = 'ready';
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    pending++;
    changed();
    const result = queue.then(async () => {
      error = '';
      try { return await work(); }
      catch (cause) {
        if (!(cause instanceof LoginRequiredError)) {
          error = cause instanceof Error ? cause.message : '个人数据操作失败，请重试';
          status = 'error';
        }
        throw cause;
      } finally { pending--; changed(); }
    });
    queue = result.catch(() => {});
    return result;
  }

  const refresh = () => enqueue(async () => {
    initialized = false;
    try { await initialize(); }
    catch (cause) { if (!(cause instanceof LoginRequiredError)) throw cause; }
  });
  const ensure = () => enqueue(async () => {
    if (!initialized && status !== 'signed-out') {
      try { await initialize(); }
      catch (cause) { if (!(cause instanceof LoginRequiredError)) throw cause; }
    }
  });
  function mutate(action: PersonalAction | (() => PersonalAction)) {
    return enqueue(async () => {
      if (!initialized && status !== 'signed-out') {
        try { await initialize(); }
        catch (cause) { if (!(cause instanceof LoginRequiredError)) throw cause; }
      }
      // 收藏目标值在初始化及前序写入完成后计算；401访问静默丢弃，不写本地。
      const resolved = typeof action === 'function' ? action() : action;
      if (status === 'signed-out') {
        if (resolved.action === 'visit') return;
        throw new LoginRequiredError();
      }
      try { data = await request(resolved); }
      catch (cause) {
        if (cause instanceof LoginRequiredError && resolved.action === 'visit') {
          return;
        }
        throw cause;
      }
      status = 'ready';
      options.broadcast?.();
    });
  }
  return {
    snapshot, ensure, refresh, mutate,
    read: (kind: PersonalKind) => data[kind],
    toggleFavorite: (siteId: string) => mutate(() => ({ action: 'favorite', siteId,
      selected: !data.favorites.some((item) => item.siteId === siteId) })),
    recordVisit: (siteId: string, visitType: VisitType) => mutate({ action: 'visit', siteId, visitType }),
    remove: (kind: PersonalKind, siteId: string) => mutate({ action: 'remove', kind, siteId }),
    clear: (kind: PersonalKind) => mutate({ action: 'clear', kind }),
  };
}
