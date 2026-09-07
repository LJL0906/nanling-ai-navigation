import type { Site } from '../lib/types';
import type { NavigationSnapshot } from './repository';
import { HttpError } from './http.ts';

export function parseSiteQuery(params: URLSearchParams) {
  const integer = (key: string, fallback: number, maximum: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > maximum) {
      throw new HttpError(400, 'INVALID_QUERY', `${key} 必须为1至${maximum}的整数。`);
    }
    return Number(raw);
  };
  const q = (params.get('q') ?? '').normalize('NFKC').trim();
  const category = params.get('category') ?? '';
  if (q.length > 200 || (category && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(category))) {
    throw new HttpError(400, 'INVALID_QUERY', '搜索词过长或分类格式不正确。');
  }
  return { q, category, page: integer('page', 1, 1_000_000), pageSize: integer('pageSize', 48, 100) };
}

/** API 只序列化公开展示字段，不散布 sources / alternateUrls 等原始记录。 */
export function siteSummary(site: Site) {
  const { id, name, slug, url, desc, categorySlug, domain, icon, color, mono, verification } = site;
  return { id, name, slug, url, desc, categorySlug, domain, icon, color, mono, verification };
}

export function listSites(snapshot: NavigationSnapshot, query: ReturnType<typeof parseSiteQuery>) {
  if (query.category && !snapshot.categories.some((category) => category.slug === query.category)) {
    throw new HttpError(404, 'CATEGORY_NOT_FOUND', '分类不存在。');
  }
  const words = query.q.toLowerCase().split(/\s+/u).filter(Boolean);
  const matches = snapshot.categories
    .filter((category) => !query.category || category.slug === query.category)
    .flatMap((category) => category.sites.filter((site) => {
      const text = [site.name, site.slug, site.desc, site.domain, category.name,
        ...site.aliases, ...site.tags, ...site.sourceCategories].join(' ').normalize('NFKC').toLowerCase();
      return words.every((word) => text.includes(word));
    }));
  const start = (query.page - 1) * query.pageSize;
  return {
    data: matches.slice(start, start + query.pageSize).map(siteSummary),
    pagination: { page: query.page, pageSize: query.pageSize, total: matches.length,
      totalPages: Math.max(1, Math.ceil(matches.length / query.pageSize)) },
  };
}
