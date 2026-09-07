import type { UnifiedCategory, UnifiedNavigation, UnifiedSite } from '../lib/navigation-types';
import { HttpError } from './http.ts';

export interface DatabaseRow { id: string; slug: string; category_id?: string; payload: unknown; }

function invalid(): never { throw new HttpError(503, 'DATABASE_DATA_INVALID', '数据库导航数据不完整，请检查表结构和初始化导入。'); }
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const slug = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
const reserved = new Set(['admin', 'api', 'login', 'register', 'categories', 'search', 'tags', 'articles', 'favorites', 'history', 'settings', 'notifications', 'quick-search', 'entertainment', '404']);
function record(row: DatabaseRow) {
  let value = row.payload;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { invalid(); }
  }
  if (!object(value) || row.id !== value.id || row.slug !== value.slug || !nonEmpty(value.id) || !slug(value.slug) || !nonEmpty(value.name)) invalid();
  return value;
}

/** SQL索引字段与JSON原始记录同时校验，防止错误导入产生错路由或丢数据。 */
export function decodeNavigationRows(categoryRows: DatabaseRow[], siteRows: DatabaseRow[]): UnifiedNavigation {
  if (!categoryRows.length || !siteRows.length) throw new HttpError(503, 'DATABASE_NOT_INITIALIZED', '数据库尚未导入导航数据，请先完成初始化。');
  const ids = new Set<string>();
  const slugs = new Set<string>();
  const categories = categoryRows.map((row): UnifiedCategory => {
    const value = record(row);
    if (ids.has(value.id as string) || slugs.has(value.slug as string) || reserved.has(value.slug as string)
      || typeof value.color !== 'string' || !/^#[\da-f]{6}$/i.test(value.color)
      || !nonEmpty(value.icon) || !Number.isSafeInteger(value.order) || Number(value.order) < 0) invalid();
    ids.add(value.id as string);
    slugs.add(value.slug as string);
    return { ...(value as unknown as UnifiedCategory), count: 0 };
  });
  const siteIds = new Set<string>();
  const routes = new Set<string>();
  const counts = new Map<string, number>();
  const sites = siteRows.map((row): UnifiedSite => {
    const value = record(row);
    if (typeof value.category !== 'string' || row.category_id !== value.category || !ids.has(value.category)
      || typeof value.description !== 'string' || !nonEmpty(value.domain)
      || !strings(value.aliases) || !strings(value.alternateUrls) || !strings(value.tags) || !strings(value.sourceCategories)
      || !Array.isArray(value.sources) || !value.sources.every((source) => object(source) && nonEmpty(source.dataset) && nonEmpty(source.recordId))
      || !object(value.verification) || !nonEmpty(value.verification.status)) invalid();
    if (!nonEmpty(value.url)) invalid();
    try { if (!['http:', 'https:'].includes(new URL(value.url).protocol)) invalid(); } catch { invalid(); }
    if (value.icon !== null && (!object(value.icon) || !['iconify', 'url', 'raw'].includes(String(value.icon.type)) || !nonEmpty(value.icon.value))) invalid();
    const route = `${value.category}/${value.slug}`;
    if (siteIds.has(String(value.id)) || routes.has(route)) invalid();
    siteIds.add(String(value.id)); routes.add(route);
    counts.set(value.category, (counts.get(value.category) ?? 0) + 1);
    return value as unknown as UnifiedSite;
  });
  for (const category of categories) category.count = counts.get(category.id) ?? 0;
  return { categories, sites };
}


