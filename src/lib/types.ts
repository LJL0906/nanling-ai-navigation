import type { SourceIcon, SourceRecord, Verification } from './navigation-types';

/** 页面统一站点模型。保留旧卡片字段，原始数据只在适配层转换。 */
export interface Site {
  id: string;
  name: string;
  slug: string;
  url: string;
  desc: string;
  icon: string | null;
  color: string;
  mono?: string;
  preview?: 'light' | 'blue' | 'dark';
  categorySlug: string;
  aliases: string[];
  alternateUrls: string[];
  domain: string;
  tags: string[];
  sourceCategories: string[];
  sourceIcon: SourceIcon | null;
  sources: SourceRecord[];
  verification: Verification;
}

/** 分类在首页的展示方式；limit 只限制首页，不截断站点库。 */
export interface HomeDisplay {
  show: boolean;
  layout: 'grid' | 'preview';
  moreLabel: string;
  limit: number;
}

export interface Category {
  id: string;
  slug: string;
  name: string;
  desc: string;
  keywords: string;
  color: string;
  icon: string;
  home: HomeDisplay;
  sites: Site[];
}

/** 旧数据仅用于精选顺序、视觉配置及旧链接迁移，不再提供全站内容。 */
export type LegacySite = Pick<Site, 'name' | 'slug' | 'url' | 'desc' | 'icon' | 'color' | 'mono' | 'preview'>;
export interface LegacyCategory extends Omit<Category, 'id' | 'sites' | 'home'> {
  home: Omit<HomeDisplay, 'limit'>;
  sites: LegacySite[];
}
