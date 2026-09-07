import { createHash } from 'node:crypto';
import lucide from '@iconify-json/lucide/icons.json' with { type: 'json' };
import type { MenuSeedItem, JsonObject } from './menu-seed.ts';
import { HttpError } from './http.ts';
import { curatedPayloadError, safeCuratedHref } from '../lib/curated-menu-fields.ts';

const locations = new Set(['sidebar', 'sidebar-footer', 'topbar', 'topbar-actions']);
const kinds = new Set(['link', 'category', 'group', 'resource']);
const iconNames = new Set([...Object.keys(lucide.icons), ...Object.keys(lucide.aliases ?? {})]);
const fields = new Set(['id','parentId','location','kind','label','href','icon','sortOrder','enabled','payload']);
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
function invalid(message: string): never { throw new HttpError(400, 'INVALID_MENU', message); }
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
const id = (v: unknown): v is string => text(v, 191) && /^[a-zA-Z0-9:/_.-]+$/.test(v);

export function safeMenuHref(value: unknown): value is string {
  return safeCuratedHref(value, true);
}
function checkJson(value: unknown, depth = 0): void {
  if (depth > 8) invalid('菜单补充信息嵌套过深。');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(v => checkJson(v, depth + 1)); return; }
  if (!record(value)) invalid('菜单补充信息必须是有效 JSON。');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__','prototype','constructor'].includes(key)) invalid('菜单补充信息包含禁止的属性。');
    checkJson(child, depth + 1);
  }
}

/** 同时用于入站校验与数据库回读；不允许原始 HTML、脚本链接或任意图标集。 */
export function validateMenus(value: unknown): MenuSeedItem[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) invalid('菜单总数必须为 1 至 500 条。');
  const menus: MenuSeedItem[] = value.map(row => {
    if (!record(row) || Object.keys(row).some(k => !fields.has(k))) invalid('菜单字段不完整或包含未知字段。');
    if (!id(row.id) || (row.parentId !== null && !id(row.parentId))) invalid('菜单 ID 或父菜单 ID 无效。');
    if (typeof row.location !== 'string' || !locations.has(row.location) || typeof row.kind !== 'string' || !kinds.has(row.kind)) invalid('菜单位置或类型无效。');
    if (!text(row.label, 255)) invalid('菜单名称不能为空、含控制字符或超过 255 字符。');
    if (row.icon !== null && (typeof row.icon !== 'string' || !row.icon.startsWith('lucide:') || !iconNames.has(row.icon.slice(7)))) invalid('请选择已安装的 lucide 图标，或留空。');
    if (!Number.isInteger(row.sortOrder) || Number(row.sortOrder) < 0 || Number(row.sortOrder) > 1000000) invalid('菜单排序必须是 0 至 1000000 的整数。');
    if (typeof row.enabled !== 'boolean' || !record(row.payload)) invalid('启用状态或菜单补充信息无效。');
    checkJson(row.payload);
    const curatedError = curatedPayloadError(row.payload);
    if (curatedError) invalid(curatedError);
    if (JSON.stringify(row.payload).length > 16000) invalid('单条菜单补充信息过大。');
    if (row.kind === 'group') {
      if (row.parentId !== null || row.href !== null || !['topbar','topbar-actions'].includes(String(row.location))) invalid('分组仅支持顶部根菜单，且不能设置链接。');
    } else if (!safeMenuHref(row.href)) invalid('菜单链接仅支持站内绝对路径或不含账号密码的 HTTP(S) 地址。');
    if (row.parentId !== null && !['link','resource'].includes(String(row.kind))) invalid('子菜单只支持链接或资源。');
    if (row.parentId !== null && !['topbar','topbar-actions'].includes(String(row.location))) invalid('侧栏不支持子菜单。');
    if (row.kind === 'resource' && (row.location !== 'topbar' || row.parentId === null)) invalid('资源必须位于顶部菜单分组内。');
    if (row.kind === 'category') {
      const slug = typeof row.href === 'string' ? /^\/#([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(row.href)?.[1] : undefined;
      if (row.location !== 'sidebar' || !slug || row.payload.homeAnchor !== slug || row.payload.categoryPath !== `/${slug}/`) invalid('分类菜单必须保留一致的首页锚点和分类路径。');
    } else if ('homeAnchor' in row.payload || 'categoryPath' in row.payload) invalid('只有分类菜单可以设置分类锚点信息。');
    if ('menuId' in row.payload && !text(row.payload.menuId, 191)) invalid('个人排序键无效。');
    if ('target' in row.payload && (typeof row.payload.target !== 'string' || !['_blank','_self'].includes(row.payload.target))) invalid('链接打开方式无效。');
    for (const key of ['description','useCase','caption','groupId']) {
      if (key in row.payload && (typeof row.payload[key] !== 'string' || row.payload[key].length > 4000)) invalid('菜单描述或展示属性无效。');
    }
    return { id: row.id, parentId: row.parentId, location: String(row.location), kind: String(row.kind), label: row.label,
      href: row.href as string | null, icon: row.icon as string | null, sortOrder: Number(row.sortOrder), enabled: row.enabled,
      payload: structuredClone(row.payload) as JsonObject };
  });
  const byId = new Map(menus.map(row => [row.id, row]));
  if (byId.size !== menus.length) invalid('菜单 ID 不可重复。');
  const sidebarKeys = menus.filter(m => m.location === 'sidebar').map(m => m.payload.menuId ?? (m.href === '/' ? '/' : m.id));
  if (new Set(sidebarKeys).size !== sidebarKeys.length) invalid('侧栏个人排序键不可重复。');
  for (const menu of menus) {
    if (menu.parentId !== null) {
      const parent = byId.get(menu.parentId);
      if (!parent || parent.id === menu.id || parent.parentId !== null || parent.kind !== 'group' || parent.location !== menu.location) invalid('父菜单必须是同一区域的根分组，不允许循环或多层嵌套。');
    }
  }
  return sortMenus(menus);
}
export function sortMenus(menus: MenuSeedItem[]): MenuSeedItem[] {
  return [...menus].sort((a,b) => a.location.localeCompare(b.location) || (a.parentId ?? '').localeCompare(b.parentId ?? '') || a.sortOrder-b.sortOrder || a.id.localeCompare(b.id));
}
export function visibleMenus(menus: MenuSeedItem[]): MenuSeedItem[] {
  const enabled = new Set(menus.filter(m => m.enabled).map(m => m.id));
  return sortMenus(menus.filter(m => m.enabled && (m.parentId === null || enabled.has(m.parentId))));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export const menuRevision = (menus: MenuSeedItem[]) => createHash('sha256').update(canonical(sortMenus(menus))).digest('hex');
