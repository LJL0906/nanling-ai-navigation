import { createHash, randomUUID } from 'node:crypto';
import { parseRequestKey, submissionDigest } from './submission-idempotency.ts';
import type { SiteSubmission } from './site-submissions.ts';

/** 请求键不是提交编号；身份域进入稳定编号及指纹，旧匿名记录不会被新账号认领。 */
export function submissionIdentity(data: SiteSubmission, key: string | undefined, userId: string | null) {
  const scope = userId === null ? 'anonymous' : `user:${userId}`;
  const parsed = parseRequestKey(key ?? null);
  const digest = createHash('sha256').update(`submission:v2\0${scope}\0${submissionDigest(data)}`).digest('hex');
  if (!parsed) return { id: randomUUID(), digest };
  const hash = createHash('sha256').update(`submission:v2\0${scope}\0${parsed}`).digest('hex');
  // 标准 UUID 形状及版本/variant 位；128-bit 截断不包含用户原始编号。
  const id = `${hash.slice(0,8)}-${hash.slice(8,12)}-8${hash.slice(13,16)}-${((parseInt(hash[16],16)&3)|8).toString(16)}${hash.slice(17,20)}-${hash.slice(20,32)}`;
  return { id, digest };
}
