import { SITE } from '../config/site.ts';
import { HttpError } from './http.ts';

export type SiteSettings = { -readonly [K in keyof typeof SITE]: string };
export interface RuntimeSettings { site: SiteSettings; homeSectionPageSize: number; }
export interface SettingsSnapshot extends RuntimeSettings { revision: string; writable: boolean; }
export interface SettingsCommand extends RuntimeSettings { revision: string; }
export const SITE_FIELDS = Object.keys(SITE) as (keyof SiteSettings)[];
/** 字符串长度按 Unicode 码点计数；所有字段必填，不接受控制字符。 */
export const SITE_FIELD_LIMITS: Record<keyof SiteSettings, number> = {
  url: 2048, name: 100, slogan: 200, heroTitle: 200, heroSubtitle: 500,
  description: 1000, keywords: 1000,
};
function invalid(message: string): never { throw new HttpError(400, 'INVALID_SETTINGS', message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('配置必须为 JSON 对象。');
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !fields.includes(key))) invalid('配置字段缺失或包含未知字段。');
}
export function validateSiteSettings(input: unknown): SiteSettings {
  const value = object(input);
  exact(value, SITE_FIELDS);
  const result = {} as SiteSettings;
  for (const field of SITE_FIELDS) {
    const text = value[field];
    if (typeof text !== 'string' || !text.trim() || [...text].length > SITE_FIELD_LIMITS[field] ||
        /[\u0000-\u001f\u007f]/u.test(text)) invalid(`${field} 必须是长度不超过 ${SITE_FIELD_LIMITS[field]} 的非空字符串。`);
    result[field] = text.trim();
  }
  try {
    const url = new URL(result.url);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== '/' ||
        url.search || url.hash || /[?#\\]/.test(result.url) || !/^https?:\/\//i.test(result.url)) throw new Error();
    result.url = url.origin;
  } catch { invalid('url 必须是 http(s) 站点 origin，不能包含账号、路径、查询参数或片段。'); }
  return result;
}
export function validateHomeSectionPageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 48) invalid('homeSectionPageSize 必须为 1 至 48 的整数。');
  return value;
}
export function validateSettings(input: unknown): RuntimeSettings {
  const value = object(input);
  exact(value, ['site', 'homeSectionPageSize']);
  return { site: validateSiteSettings(value.site), homeSectionPageSize: validateHomeSectionPageSize(value.homeSectionPageSize) };
}
export function validateSettingsCommand(input: unknown): SettingsCommand {
  const value = object(input);
  exact(value, ['site', 'homeSectionPageSize', 'revision']);
  if (typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)) invalid('revision 必须是读取配置时返回的版本。');
  return { ...validateSettings({ site: value.site, homeSectionPageSize: value.homeSectionPageSize }), revision: value.revision };
}
/** 仅数据库读取允许忽略历史字段；缺少当前字段或值损坏仍须报错。 */
export function readStoredSiteSettings(input: unknown): SiteSettings {
  const value = object(input);
  return validateSiteSettings(Object.fromEntries(SITE_FIELDS.map(key => [key, value[key]])));
}

