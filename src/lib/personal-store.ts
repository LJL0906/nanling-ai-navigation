import { isValidSiteId } from './site-id.ts';
/** 浏览器本地数据仓库。后续后端接入可替换此模块，不在页面内散落存储操作。 */
export type PersonalKind = 'favorites' | 'history';
export type VisitType = 'detail' | 'external';
export interface PersonalRecord { siteId: string; updatedAt: string; visitType?: VisitType; }
export interface StoragePort { getItem(key: string): string | null; setItem(key: string, value: string): void; }
export const PERSONAL_KEYS = { favorites: 'nav:favorites:v1', history: 'nav:history:v1' } as const;
export const HISTORY_LIMIT = 100;


export function createPersonalStore(storage: StoragePort, now = () => new Date().toISOString()) {
  function read(kind: PersonalKind): PersonalRecord[] {
    // 存储访问失败向调用方抛错，不能把“读取失败”当作空列表覆盖原数据。
    const raw = storage.getItem(PERSONAL_KEYS[kind]);
    let values: unknown;
    try { values = JSON.parse(raw ?? '[]'); } catch { return []; }
    if (!Array.isArray(values)) return [];
    const seen = new Set<string>();
    const items = values.filter((item): item is PersonalRecord => Boolean(item)
      && isValidSiteId(item.siteId) && typeof item.updatedAt === 'string' && Number.isFinite(Date.parse(item.updatedAt)))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .filter((item) => { if (seen.has(item.siteId)) return false; seen.add(item.siteId); return true; })
      .map(({ siteId, updatedAt, visitType }) => ({ siteId, updatedAt,
        ...(visitType === 'detail' || visitType === 'external' ? { visitType } : {}) }));
    return kind === 'history' ? items.slice(0, HISTORY_LIMIT) : items;
  }
  function write(kind: PersonalKind, values: PersonalRecord[]) {
    storage.setItem(PERSONAL_KEYS[kind], JSON.stringify(values));
  }
  function remove(kind: PersonalKind, siteId: string) {
    write(kind, read(kind).filter((item) => item.siteId !== siteId));
  }
  function toggleFavorite(siteId: string): boolean {
    if (!isValidSiteId(siteId)) throw new Error('无效的站点 ID');
    const items = read('favorites');
    const selected = !items.some((item) => item.siteId === siteId);
    write('favorites', selected ? [{ siteId, updatedAt: now() }, ...items] : items.filter((item) => item.siteId !== siteId));
    return selected;
  }
  function recordVisit(siteId: string, visitType: VisitType) {
    if (!isValidSiteId(siteId)) throw new Error('无效的站点 ID');
    const items = read('history').filter((item) => item.siteId !== siteId);
    write('history', [{ siteId, updatedAt: now(), visitType }, ...items].slice(0, HISTORY_LIMIT));
  }
  return { read, remove, toggleFavorite, recordVisit, clear: (kind: PersonalKind) => write(kind, []) };
}
