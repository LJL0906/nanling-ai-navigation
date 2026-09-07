/** 精选菜单共用的纯校验：浏览器、服务端与离线测试使用同一规则。 */
export function safeCuratedHref(value: unknown, internal = false): value is string {
  if (typeof value !== 'string' || !value || value.length > 2048
    || /[\s\\\u0000-\u001f\u007f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) return false;
  if (value.startsWith('/')) return internal && !value.startsWith('//') && !/^\/%2f/i.test(value);
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}
export const curatedFields = ['description', 'useCase', 'sourceUrl', 'sourceTitle', 'checkedAt'] as const;
export type CuratedField = typeof curatedFields[number];
export function validCheckedAt(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** 缺少来源允许逐步补录；填写后的 URL、日期与文本必须有效。 */
export function curatedPayloadError(payload: Record<string, unknown>): string | null {
  for (const key of curatedFields) {
    if (!(key in payload)) continue;
    const value = payload[key];
    const limit = key === 'sourceUrl' ? 2048 : key === 'sourceTitle' ? 255 : key === 'checkedAt' ? 10 : 4000;
    if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return `${key} 格式无效或超过 ${limit} 字符。`;
    if (key === 'sourceUrl' && value !== '' && !safeCuratedHref(value)) return '来源链接只支持不含账号密码的完整 HTTP(S) 地址。';
    if (key === 'checkedAt' && value !== '' && !validCheckedAt(value)) return '核对日期必须是有效的 YYYY-MM-DD 日期。';
  }
  return null;
}
/** 可视化字段只覆盖实际编辑的键，保留高级 JSON 与其他已有属性。 */
export function mergeCuratedFields(payload: Record<string, unknown>, edits: Partial<Record<CuratedField, string>>) {
  const next = { ...payload };
  for (const key of curatedFields) {
    if (!Object.hasOwn(edits, key)) continue;
    const value = edits[key]!.trim();
    if (value) next[key] = value;
    else delete next[key];
  }
  const error = curatedPayloadError(next);
  if (error) throw new Error(error);
  return next;
}
