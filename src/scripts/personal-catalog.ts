import { isValidSiteId } from '../lib/site-id.ts';
export interface PersonalSite {
  id: string; name: string; slug: string; url: string; desc: string;
  color: string; mono?: string; icon?: string | null; categorySlug: string; categoryName: string;
}
let pending: Promise<Map<string, PersonalSite>> | undefined;
export function loadPersonalSites() {
  pending ??= fetch('/personal-sites.json').then((response) => {
    if (!response.ok) throw new Error('站点索引加载失败');
    return response.json() as Promise<PersonalSite[]>;
  }).then((items) => {
    if (!Array.isArray(items)) throw new Error('站点索引格式错误');
    for (const item of items) {
      if (!item || !isValidSiteId(item.id)
        || !['name', 'desc', 'categoryName', 'url'].every((key) => typeof item[key as keyof PersonalSite] === 'string')
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.slug)
        || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.categorySlug)) throw new Error('站点索引字段无效');
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('站点网址无效');
    }
    return new Map(items.map((item) => [item.id, item]));
  }).catch((error: unknown) => { pending = undefined; throw error; });
  return pending;
}

