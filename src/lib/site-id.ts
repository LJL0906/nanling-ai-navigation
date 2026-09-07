const LEGACY_SITE_ID = /^site_[a-z0-9]+$/i;
const UUID_SITE_ID = /^(?:site|submitted)-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 共用站点 ID 契约：兼容种子、后台创建及审核发布，不改写数据库 ID。 */
export function isValidSiteId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && !/[\r\n]/.test(value) && (LEGACY_SITE_ID.test(value) || UUID_SITE_ID.test(value));
}
