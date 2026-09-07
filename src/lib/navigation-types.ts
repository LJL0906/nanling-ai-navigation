/** 统一站点库的输入模型；来源和验证状态只在构建端保留。 */
export interface SourceRecord {
  dataset: string;
  recordId: string;
  category: string | null;
  subcategory: string | null;
  detailUrl: string | null;
  originalUrl: string;
}

export interface SourceIcon {
  type: 'iconify' | 'url' | 'raw';
  value: string;
  color?: string;
}

export interface Verification {
  status: 'unverified' | 'online' | 'offline' | 'redirect' | 'blocked' | 'active' | 'pending-review';
  checkedAt: string | null;
}

export interface UnifiedSite {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  url: string;
  alternateUrls: string[];
  domain: string;
  description: string;
  /** 数据关联使用 id，不是页面路径 slug。 */
  category: string;
  sourceCategories: string[];
  tags: string[];
  icon: SourceIcon | null;
  sources: SourceRecord[];
  verification: Verification;
}

export interface UnifiedCategory {
  id: string;
  slug: string;
  name: string;
  color: string;
  icon: string;
  order: number;
  count: number;
}

export interface UnifiedNavigation {
  categories: UnifiedCategory[];
  sites: UnifiedSite[];
}
