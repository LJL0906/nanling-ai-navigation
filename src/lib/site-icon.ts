/** 只接受采集器约定的根相对路径，不接受 SVG、查询串、编码或目录跳转。 */
export function isLocalSiteIcon(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && /^\/site-icons\/[a-f0-9]{64}\.(?:png|ico|jpg|gif|webp)$/.test(value);
}
