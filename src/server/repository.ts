import type { Category } from '../lib/types';

/** 页面与 API 共用的仓储契约。接入数据库时替换实现，不改页面字段。 */
export interface NavigationSnapshot {
  categories: Category[];
  homeCategories: Category[];
  siteCount: number;
  siteRedirects: { from: string; to: string }[];
}

export interface NavigationRepository {
  readonly storage: { driver: string; databaseConnected: boolean; writable: boolean };
  getNavigation(): Promise<NavigationSnapshot>;
}
