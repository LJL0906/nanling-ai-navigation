import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { lstat, open, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { requireAdmin } from './auth.ts';
import { getAdminSession } from './admin-session.ts';
import { api, HttpError, methodNotAllowed } from './http.ts';
import { submissionDirectory } from './submission-idempotency.ts';
import { getStorageDriver } from './database-config.ts';

export type ReviewStatus = 'pending' | 'approved' | 'rejected';
export type ReviewItem = {
  id: string; name: string; url: string; categoryId: string; customCategory: string;
  iconUrl: string; remark: string; createdAt: string; status: ReviewStatus;
  reviewReason: string; reviewedAt: string | null; reviewedBy: string | null; publishedSiteId: string | null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const statuses: ReviewStatus[] = ['pending', 'approved', 'rejected'];
const fail = (status: number, code: string, message: string): never => { throw new HttpError(status, code, message); };
const errno = (error: unknown) => (error as NodeJS.ErrnoException).code;
function validId(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) return fail(400, 'INVALID_ID', '提交编号必须为小写 UUID。');
  return value;
}
function item(record: Record<string, unknown>): ReviewItem {
  const text = (key: string) => typeof record[key] === 'string' ? record[key] as string : '';
  return { id: text('id'), name: text('name'), url: text('url'), categoryId: text('categoryId'),
    customCategory: text('customCategory'), iconUrl: text('iconUrl'), remark: text('remark'), createdAt: text('createdAt'),
    status: record.status as ReviewStatus, reviewReason: text('reviewReason'),
    reviewedAt: text('reviewedAt') || null, reviewedBy: text('reviewedBy') || null, publishedSiteId: text('publishedSiteId') || null };
}
async function readRecord(root: string, id: string): Promise<Record<string, unknown>> {
  const path = join(root, `${validId(id)}.json`);
  try {
    // 数据目录只允许服务端写入；拒绝符号链接、目录和异常体积记录。
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('Invalid record file');
    const file = await open(path, 'r');
    let record: Record<string, unknown>;
    try { record = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
    if (!record || Array.isArray(record) || record.id !== id || !statuses.includes(record.status as ReviewStatus)
      || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
      throw new Error('Invalid persisted submission');
    }
    return record;
  } catch (error) {
    if (errno(error) === 'ENOENT') return fail(404, 'SUBMISSION_NOT_FOUND', '提交记录不存在。');
    throw error;
  }
}
function integer(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
    return fail(400, 'INVALID_PAGINATION', '分页参数必须为范围内的正整数。');
  }
  return Number(value);
}
export async function listSubmissions(params: URLSearchParams, directory?: string) {
  for (const key of params.keys()) {
    if (!['status', 'page', 'pageSize', 'q'].includes(key) || params.getAll(key).length !== 1) {
      fail(400, 'INVALID_QUERY', '筛选参数无效或重复。');
    }
  }
  const q = (params.get('q') ?? '').trim();
  if (q.length > 100) fail(400, 'INVALID_QUERY', '站点名称搜索最多为 100 字。');
  const status = params.get('status') ?? 'pending';
  if (!statuses.includes(status as ReviewStatus)) fail(400, 'INVALID_STATUS', '仅支持待审、通过、拒绝状态。');
  const page = integer(params.get('page'), 1, 1000000);
  const pageSize = integer(params.get('pageSize'), 20, 100);
  if (directory === undefined) {
    const { listMySqlSubmissions } = await import('./mysql-submissions.ts');
    const { items, total } = await listMySqlSubmissions({ status: status as ReviewStatus, page, pageSize, q });
    return { items: items.map(item), total, page, pageSize, totalPages: Math.ceil(total / pageSize), status };
  }
  const root = submissionDirectory(directory);
  let entries: Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (errno(error) !== 'ENOENT') throw error; entries = []; }
  const items: ReviewItem[] = [];
  const search = q.toLowerCase();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5))) continue;
    const record = await readRecord(root, entry.name.slice(0, -5));
    if (record.status !== status) continue;
    const candidate = item(record);
    if (candidate.name.toLowerCase().includes(search)) items.push(candidate);
  }
  items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  return { items: items.slice((page - 1) * pageSize, page * pageSize), total: items.length,
    page, pageSize, totalPages: Math.ceil(items.length / pageSize), status };
}
function decision(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'INVALID_REVIEW', '审核内容须为 JSON 对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['id', 'status', 'reason'].includes(key))) fail(400, 'INVALID_REVIEW', '审核包含未知字段。');
  const id = validId(input.id);
  if (input.status !== 'approved' && input.status !== 'rejected') fail(400, 'INVALID_STATUS', '审核结果须为通过或拒绝。');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 1000
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(input.reason)) {
    fail(400, 'INVALID_REASON', '请填写 1–1000 字的审核理由，不允许控制字符。');
  }
  return { id, status: input.status as 'approved' | 'rejected', reason: (input.reason as string).trim() };
}
/**
 * 每条记录独立 wx 文件锁，跨进程审核互斥；同步临时文件后原子替换，保留提交所有原字段。
 * 异常退出遗留锁时失败关闭，不自动按时间抢锁；须停写确认无存活审核进程后人工清理。
 * 与提交模块一样，目录仅供受信服务写入；不支持外部程序绕过锁改写/删除记录。
 */
export async function reviewSubmission(value: unknown, directory?: string, administrator = 'admin'): Promise<ReviewItem> {
  const review = decision(value);
  if (!administrator.trim() || administrator.length > 200) throw new Error('Invalid administrator');
  if (directory === undefined) {
    if (getStorageDriver() !== 'mysql') {
      fail(503, 'PUBLISH_STORAGE_READ_ONLY', '当前前台使用种子数据，请切换到 MySQL 后再审核发布。');
    }
    const { reviewMySqlSubmission } = await import('./mysql-submissions.ts');
    return item(await reviewMySqlSubmission(review.id, review.status, review.reason, administrator));
  }
  const root = submissionDirectory(directory);
  const lockPath = join(root, `.${review.id}.review.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (errno(error) === 'ENOENT') return fail(404, 'SUBMISSION_NOT_FOUND', '提交记录不存在。');
    if (errno(error) === 'EEXIST') return fail(409, 'REVIEW_CONFLICT', '该记录正在审核或存在未清理的审核锁，请刷新后重试。');
    throw error;
  }
  const temporary = join(root, `.${review.id}.${randomUUID()}.review.tmp`);
  try {
    const record = await readRecord(root, review.id);
    if (record.status !== 'pending') fail(409, 'REVIEW_CONFLICT', '该提交已审核，不允许重复审批。');
    const updated = { ...record, status: review.status, reviewReason: review.reason,
      reviewedAt: new Date().toISOString(), reviewedBy: administrator };
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(updated, null, 2) + '\n', 'utf8'); await file.sync(); }
    finally { await file.close(); }
    // Windows 的短暂读取句柄可能阻止替换；始终持锁有限重试，绝不先删除目标文件。
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, join(root, `${review.id}.json`)); break; }
      catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(errno(error) ?? '') || attempt >= 5) throw error;
        await delay(20 * (attempt + 1));
      }
    }
    if (process.platform !== 'win32') {
      const folder = await open(root, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    }
    return item(updated);
  } finally {
    await unlink(temporary).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}
async function readReviewRequest(request: Request): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) fail(415, 'JSON_REQUIRED', '请使用 JSON 提交审核。');
  const limit = 8192;
  if (Number(request.headers.get('content-length')) > limit) fail(413, 'BODY_TOO_LARGE', '审核请求过大。');
  if (!request.body) fail(400, 'INVALID_JSON', '缺少审核内容。');
  const reader = request.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '审核请求过大。'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { return fail(400, 'INVALID_JSON', '审核内容不是有效 JSON。'); }
}
export function createSubmissionReviewHandler(options: { directory?: string } = {}) {
  return (request: Request): Promise<Response> => api(async () => {
    // 复用 Cookie/Bearer 鉴权及 Cookie 写请求同源检查。
    requireAdmin(request);
    if (request.method === 'GET') return { data: await listSubmissions(new URL(request.url).searchParams, options.directory) };
    if (request.method === 'PATCH') return { data: await reviewSubmission(await readReviewRequest(request), options.directory, getAdminSession(request)?.username ?? 'admin') };
    return methodNotAllowed('GET, PATCH');
  });
}







