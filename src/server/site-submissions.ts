import { requireUser } from './account.ts';
import { accountToken } from './account-security.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { api, HttpError, json } from './http.ts';
import { parseRequestKey, runIdempotentSubmission, submissionDigest, submissionDirectory,
  type RequestIdentity } from './submission-idempotency.ts';

export const MAX_BODY_BYTES = 1536 * 1024;
export const MAX_ICON_BYTES = 1024 * 1024;
const fields = ['categoryId', 'customCategory', 'name', 'url', 'iconUrl', 'iconData'] as const;
export type SiteSubmission = Record<typeof fields[number], string> & { remark?: string };
type Category = { id: string };
type Categories = () => Promise<readonly Category[]>;
export type SubmissionIcon = { key: string; url: string };
type IconUploader = (iconData: string) => Promise<SubmissionIcon>;
const uploadIcon: IconUploader = async (iconData) => {
  const { uploadSubmissionIcon } = await import('./oss-storage.ts');
  return uploadSubmissionIcon(iconData);
};

function invalid(message: string): never {
  throw new HttpError(400, 'INVALID_SUBMISSION', message);
}

function httpUrl(value: string, field: string): string {
  if (value.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(value)) invalid(`${field}格式无效。`);
  try {
    const parsed = new URL(value);
    if (!/^https?:\/\//i.test(value) || !['http:', 'https:'].includes(parsed.protocol)
      || !parsed.hostname || parsed.username || parsed.password) invalid(`${field}仅允许无凭据的 HTTP 或 HTTPS 地址。`);
    return parsed.href;
  } catch {
    return invalid(`${field}格式无效。`);
  }
}

function imageData(value: string): string {
  if (value.length > Math.ceil(MAX_ICON_BYTES / 3) * 4 + 32) invalid('图标必须小于 1MB。');
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) invalid('图标须为 PNG、JPEG、WebP 或 GIF 的 base64 Data URL。');
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length >= MAX_ICON_BYTES) invalid('图标必须小于 1MB。');
  if (bytes.toString('base64') !== match[2]) invalid('图标 base64 编码无效。');
  const signature = match[1] === 'png'
    ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : match[1] === 'jpeg'
      ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
      : match[1] === 'gif'
        ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))
        : bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF'
          && bytes.subarray(8, 12).toString('latin1') === 'WEBP'
          && bytes.readUInt32LE(4) === bytes.length - 8;
  if (!signature) invalid('图标内容与声明的图片类型不符。');
  return value;
}

export function validateSubmission(value: unknown, categories: readonly Category[]): SiteSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('提交内容须为 JSON 对象。');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'remark' && !fields.includes(key as typeof fields[number]))) invalid('提交包含未知字段。');
  const data = {} as SiteSubmission;
  for (const field of fields) {
    if (typeof input[field] !== 'string') invalid(`${field}须为字符串。`);
    data[field] = field === 'iconData' ? input[field] : input[field].trim();
  }
  if (Object.hasOwn(input, 'remark')) {
    if (typeof input.remark !== 'string') invalid('备注须为字符串。');
    const remark = input.remark.trim().replace(/\r\n?/g, '\n');
    if (remark.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(remark)) {
      invalid('备注最多 500 字，且不能包含非法控制字符。');
    }
    // 空备注不参与指纹，兼容此前未携带备注的提交重试。
    if (remark) data.remark = remark;
  }
  if (!data.name || data.name.length > 100 || /[\x00-\x1f\x7f]/u.test(data.name)) invalid('站点名称须为 1–100 个字符。');
  if (Boolean(data.categoryId) === Boolean(data.customCategory)) invalid('已有分类与自定义分类必须二选一。');
  if (data.categoryId.length > 200 || (data.categoryId && !categories.some(({ id }) => id === data.categoryId))) {
    invalid('所选分类不存在。');
  }
  if (data.customCategory.length > 50 || /[\x00-\x1f\x7f]/u.test(data.customCategory)) invalid('自定义分类最多 50 个字符且不能含控制字符。');
  data.url = httpUrl(data.url, '站点 URL');
  if (data.iconUrl && data.iconData) invalid('图标 URL 与上传图标只能选择一项。');
  if (data.iconUrl) data.iconUrl = httpUrl(data.iconUrl, '图标 URL');
  if (data.iconData) data.iconData = imageData(data.iconData);
  return data;
}

function checkOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  // 不信任用户传入的 Forwarded/X-Forwarded-*；代理应正确配置应用的外部 URL。
  if (!origin || origin !== new URL(request.url).origin) {
    throw new HttpError(403, 'INVALID_ORIGIN', '仅允许本站发起提交。');
  }
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') throw new HttpError(403, 'INVALID_ORIGIN', '仅允许本站发起提交。');
}

async function readBody(request: Request): Promise<unknown> {
  const tooLarge = () => new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求内容过大。');
  const length = request.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw tooLarge();
  if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '请使用 application/json 提交。');
  }
  const encoding = request.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持压缩请求体。');
  }
  if (!request.body) invalid('请求体不能为空。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch {
    return invalid('请求体不是有效的 UTF-8 JSON。');
  }
}

/** 单进程固定窗口：每地址每 10 分钟 5 次；满容量时拒绝新地址，避免无界内存。 */
export function createSubmissionLimiter(now = Date.now) {
  const entries = new Map<string, { count: number; expires: number }>();
  return (address: string): void => {
    const time = now();
    for (const [key, entry] of entries) if (entry.expires <= time) entries.delete(key);
    const key = address || 'unknown';
    const entry = entries.get(key);
    if ((entry && entry.count >= 5) || (!entry && entries.size >= 10000)) {
      throw new HttpError(429, 'RATE_LIMITED', '提交过于频繁，请在 10 分钟后重试。');
    }
    if (entry) entry.count++;
    else entries.set(key, { count: 1, expires: time + 10 * 60 * 1000 });
  };
}

export async function saveSubmission(data: SiteSubmission, directory?: string, iconObject?: SubmissionIcon,
  identity?: RequestIdentity) {
  const root = submissionDirectory(directory);
  const id = identity?.requestKey ?? randomUUID();
  const record = { ...data, ...(iconObject ? { iconObject: { provider: 'oss', key: iconObject.key } } : {}),
    ...identity, id, status: 'pending' as const, createdAt: new Date().toISOString() };
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temporary = join(root, `.${id}.tmp`);
  const destination = join(root, `${id}.json`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(record, null, 2) + '\n', 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    // POSIX 同步目录项；Windows 不支持以相同方式 fsync 目录。
    if (process.platform !== 'win32') {
      const folder = await open(root, 'r');
      try { await folder.sync(); } finally { await folder.close(); }
    }
    return { id, status: record.status };
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** 工厂隔离测试限流状态；生产由路由模块创建一次。 */
type SubmissionHandlerOptions = { getCategories: Categories; directory?: string; uploadIcon?: IconUploader };
export function createSubmissionHandler(options: SubmissionHandlerOptions) {
  return createHandler(options, false);
}
/** 仅供历史文件迁移与离线回归；生产 API 不使用此入口。 */
export function createLegacySubmissionHandler(options: SubmissionHandlerOptions & { directory: string }) {
  if (!options.directory) throw new Error('历史文件工具必须显式指定私有目录。');
  return createHandler(options, true);
}
function createHandler(options: SubmissionHandlerOptions, legacy: boolean) {
  const limit = createSubmissionLimiter();
  return (request: Request, clientAddress: string): Promise<Response> => api(async () => {
    // 匿名在读取 body、分类、限流、OSS 或数据库持久化前拒绝。
    if (!legacy && !accountToken(request)) throw new HttpError(401, 'USER_UNAUTHORIZED', '请先登录普通用户账号。');
    const user = legacy ? null : await requireUser(request);
    checkOrigin(request);
    if (!legacy && options.directory !== undefined) throw new HttpError(503, 'SUBMISSIONS_STORAGE_READ_ONLY', '新提交需要 MySQL 账号与通知事务。');
    const header = request.headers.get('idempotency-key');
    // 无 header 保持旧客户端行为，包括校验失败计入限额。
    if (header === null) limit(clientAddress);
    let key: string | undefined;
    let data: SiteSubmission;
    try {
      key = parseRequestKey(header);
      data = validateSubmission(await readBody(request), await options.getCategories());
    } catch (error) {
      if (header !== null) limit(clientAddress);
      throw error;
    }
    // 生产默认且强制使用 MySQL；directory 仅供旧文件迁移/离线回归显式注入。
    if (options.directory === undefined) {
      const { submitToMySql } = await import('./mysql-submissions.ts');
      return json({ data: await submitToMySql(data, key, options.uploadIcon ?? uploadIcon,
        () => { if (header !== null) limit(clientAddress); }, clientAddress, user?.id ?? null) }, 201);
    }
    // 旧文件工具不能持久化账号通知，禁止带登录身份使用；生产路由不注入 directory。
    if (user) throw new HttpError(503, 'SUBMISSIONS_STORAGE_READ_ONLY', '账号提交需要 MySQL 通知事务。');
    const root = submissionDirectory(options.directory);
    const identity = key ? { requestKey: key, requestDigest: submissionDigest(data) } : undefined;
    let charged = header === null;
    const charge = () => { if (!charged) { charged = true; limit(clientAddress); } };
    const save = async () => {
      charge();
      const iconObject = data.iconData ? await (options.uploadIcon ?? uploadIcon)(data.iconData) : undefined;
      const stored = iconObject ? { ...data, iconData: '', iconUrl: iconObject.url } : data;
      return saveSubmission(stored, root, iconObject, identity);
    };
    try { return json({ data: identity ? await runIdempotentSubmission(root, identity, save) : await save() }, 201); }
    catch (error) { charge(); throw error; }
  });
}
