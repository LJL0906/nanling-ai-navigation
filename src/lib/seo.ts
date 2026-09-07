import { SITE } from '../config/site';
import type { SiteSettings } from '../server/settings-validation';

/** 全站共用的 WebSite 节点，其它结构化数据通过 @id 引用它。 */
export function createWebsiteNode(site: SiteSettings) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${site.url}/#website`,
    name: site.name,
    alternateName: site.name,
    url: site.url,
    description: site.description,
    inLanguage: 'zh-CN',
  };
}

/** 兼容默认值；前台运行时使用 factory，不改写全局配置。 */
export const websiteNode = createWebsiteNode(SITE);

export function breadcrumb(items: { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function itemList(name: string, entries: { name: string; url: string }[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name,
    numberOfItems: entries.length,
    itemListElement: entries.map((e, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: e.name,
      url: e.url,
    })),
  };
}
