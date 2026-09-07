import type { Category } from './types';

export interface CategoryFacet { key: string; label: string; indices: number[]; }

/** 数据字段只作为文本展示；键由归一化标签生成，与站点顺序、ID 和 slug 无关。 */
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const identity = (value: string) => normalize(value).toLocaleLowerCase('en-US');

// 仅过滤明确的数据来源/合并追踪标记，不按站点或用途分类设置白名单。
const internalLabels = new Set(['包含http来源', 'http来源', '项目原始精选', '多来源合并']);
const isInternalLabel = (value: string) => internalLabels.has(identity(value).replace(/\s+/g, ''));

export function buildCategoryFacets(category: Category): CategoryFacet[] {
  const groups = new Map<string, CategoryFacet>();
  const remaining: number[] = [];
  const excluded = new Set([category.name, category.slug, '全部', '全部站点'].map(identity));
  category.sites.forEach((site, index) => {
    const labels = new Map<string, string>();
    for (const value of [...(site.tags ?? []), ...(site.sourceCategories ?? [])]) {
      // 采集来源常用 “父类 | 子类”，不把整个路径再生成一个重复筛选项。
      for (const part of value.split(/[|｜>＞]+/u)) {
        const label = normalize(part);
        const id = identity(label);
        if (label && !excluded.has(id) && !isInternalLabel(label)) labels.set(id, label);
      }
    }
    if (!labels.size) remaining.push(index);
    for (const [id, label] of labels) {
      const facet = groups.get(id) ?? { key: `label:${id}`, label, indices: [] };
      facet.indices.push(index);
      groups.set(id, facet);
    }
  });
  const tabs: CategoryFacet[] = [
    { key: 'all', label: '全部', indices: category.sites.map((_, index) => index) },
    ...[...groups.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh-CN')),
  ];
  if (remaining.length) tabs.push({ key: 'unclassified', label: '未细分', indices: remaining });
  return tabs;
}

/** 先筛选完整快照，再切页；无效筛选回到全部，过期页码收敛到最后一页。 */
export function paginateCategory(category: Category, requested: string | null, requestedPage: number, pageSize: number) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('分页大小必须为正整数');
  const tabs = buildCategoryFacets(category);
  const selected = tabs.find((tab) => tab.key === requested) ?? tabs[0];
  const total = selected.indices.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(totalPages, Number.isSafeInteger(requestedPage) ? Math.max(1, requestedPage) : 1);
  const offset = (page - 1) * pageSize;
  const sites = selected.indices.slice(offset, offset + pageSize).map((index) => category.sites[index]);
  return { tabs, selected, total, totalPages, page, offset, sites };
}
