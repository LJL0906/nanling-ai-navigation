import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HttpError } from './http.ts';

export type RequestIdentity = { requestKey: string; requestDigest: string };
type Result = { id: string; status: 'pending' };
// 只保存有界的进行中摘要/Promise，不缓存成功结果或请求 base64。
const pending = new Map<string, { digest: string; result: Promise<Result> }>();
const MAX_PENDING = 1000;

export function submissionDirectory(directory?: string): string {
  return resolve(directory ?? (process.env.NAV_SUBMISSIONS_DIR?.trim() || '.data/site-submissions'));
}

export function parseRequestKey(value: string | null): string | undefined {
  if (value === null) return undefined;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key 须为有效 UUID。');
  }
  return value.toLowerCase();
}

/** 输入必须已完成字段、URL、图片校验；排序使属性插入顺序不影响指纹。 */
export function submissionDigest(data: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(
    Object.keys(data).sort().map((key) => [key, data[key]]),
  )).digest('hex');
}

function conflict(): never {
  throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', '此 Idempotency-Key 已用于不同内容，请使用新 key。');
}

async function replay(root: string, identity: RequestIdentity): Promise<Result | undefined> {
  let content: string;
  try {
    content = await readFile(join(root, `${identity.requestKey}.json`), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const record = JSON.parse(content);
  // 损坏或旧记录碰撞时失败关闭，不能覆盖已有记录或重新上传。
  if (record?.id !== identity.requestKey || record?.requestKey !== identity.requestKey
    || typeof record?.requestDigest !== 'string' || !/^[0-9a-f]{64}$/.test(record.requestDigest)) {
    throw new Error('Invalid persisted submission identity');
  }
  if (record.requestDigest !== identity.requestDigest) conflict();
  // 重放最初的提交结果，即使记录之后进入其他审核状态。
  return { id: record.id, status: 'pending' };
}

/**
 * 仅单 Node 进程互斥：同一规范绝对目录的各 handler 共享状态。
 * 不支持多进程/worker/多实例同时写同一目录，也不要通过不同符号链接配置同一目录。
 * 重启后读取原记录重放；记录删除即失去幂等历史。无额外索引或大文件副本。
 * 上传成功但保存前崩溃仍可能重传 OSS，不声称外部副作用跨崩溃 exactly-once。
 */
export async function runIdempotentSubmission(
  root: string, identity: RequestIdentity, save: () => Promise<Result>,
): Promise<Result> {
  const slot = JSON.stringify([root, identity.requestKey]);
  const existing = pending.get(slot);
  if (existing) {
    if (existing.digest !== identity.requestDigest) conflict();
    return existing.result;
  }
  if (pending.size >= MAX_PENDING) {
    throw new HttpError(503, 'SUBMISSIONS_BUSY', '提交服务繁忙，请稍后重试。');
  }
  // 在任何异步读取/上传前同步占位，避免两个首次请求同时判定记录不存在。
  const result = Promise.resolve().then(async () => (await replay(root, identity)) ?? await save());
  pending.set(slot, { digest: identity.requestDigest, result });
  try {
    return await result;
  } finally {
    pending.delete(slot);
  }
}
