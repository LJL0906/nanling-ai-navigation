import { isValidSiteId } from '../lib/site-id.ts';
import { HttpError } from './http.ts';
import type { PersonalKind, PersonalRecord, VisitType } from '../lib/personal-store.ts';
export type PersonalAction =
  | { action: 'favorite'; siteId: string; selected: boolean }
  | { action: 'visit'; siteId: string; visitType: VisitType }
  | { action: 'remove'; kind: PersonalKind; siteId: string }
  | { action: 'clear'; kind: PersonalKind }
  | { action: 'import'; favorites: PersonalRecord[]; history: PersonalRecord[] };
const fail = (): never => { throw new HttpError(400, 'INVALID_PERSONAL_DATA', '收藏或访问记录参数无效。'); };
const id = (value: unknown): string => isValidSiteId(value) ? value : fail();
const kind = (value: unknown): PersonalKind => value === 'favorites' || value === 'history' ? value : fail();
function records(value: unknown, limit: number, now: number): PersonalRecord[] {
  if (!Array.isArray(value) || value.length > limit) return fail();
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.updatedAt !== 'string') return fail();
    const siteId = id(item.siteId);
    const stamp = Date.parse(item.updatedAt);
    if (!Number.isFinite(stamp) || stamp < 0 || (item.visitType !== undefined && !['detail','external'].includes(item.visitType))) return fail();
    return { siteId, updatedAt: new Date(Math.min(stamp, now)).toISOString(), ...(item.visitType ? {visitType: item.visitType as VisitType} : {}) };
  }).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).filter(item => {
    if (seen.has(item.siteId)) return false;
    seen.add(item.siteId); return true;
  });
}
export function validatePersonalAction(value: unknown, now = Date.now()): PersonalAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  switch (v.action) {
    case 'favorite': return { action:v.action, siteId:id(v.siteId), selected:typeof v.selected === 'boolean' ? v.selected : fail() };
    case 'visit': return {action:v.action,siteId:id(v.siteId),visitType:v.visitType === 'detail' || v.visitType === 'external' ? v.visitType : fail()};
    case 'remove': return {action:v.action,kind:kind(v.kind),siteId:id(v.siteId)};
    case 'clear': return {action:v.action,kind:kind(v.kind)};
    case 'import': return {action:v.action,favorites:records(v.favorites,2500,now),history:records(v.history,100,now)};
    default: return fail();
  }
}
export async function readPersonalAction(request: Request): Promise<PersonalAction> {
  if (request.headers.get('origin') !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403,'CROSS_ORIGIN_WRITE','不允许跨站修改个人记录。');
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError(415,'JSON_REQUIRED','请提交 JSON 数据。');
  if (!request.body) return fail();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); throw new HttpError(413,'PERSONAL_BODY_TOO_LARGE','个人记录数据过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return fail(); }
  return validatePersonalAction(value);
}
