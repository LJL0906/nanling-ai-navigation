import { randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { HttpError } from './http.ts';

const MAX_ICON_BYTES = 1024 * 1024;
const MAX_BASE64_LENGTH = 4 * Math.ceil(MAX_ICON_BYTES / 3);
const KEY_PATTERN = /^site-submissions\/[0-9]{4}\/(?:0[1-9]|1[0-2])\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|webp|gif)$/;
type Environment = Readonly<Record<string, string | undefined>>;

export interface OssConfig {
  region: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
  secure: true;
  authorizationV4: true;
  timeout: number;
}

export interface OssClient {
  put(key: string, body: Buffer, options: { headers: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

type ClientFactory = (options: OssConfig) => OssClient | Promise<OssClient>;

function configurationError(): never {
  throw new HttpError(503, 'OSS_CONFIGURATION', '附件存储暂不可用，请检查服务端配置。');
}

/** 仅用于服务端构造 SDK；包含凭据，不得序列化至 API 响应或日志。 */
export function readOssConfig(env: Environment = process.env): OssConfig {
  const regionValue = env.OSS_REGION?.trim();
  const bucket = env.OSS_BUCKET?.trim();
  const accessKeyId = env.OSS_ACCESS_KEY_ID?.trim();
  const accessKeySecret = env.OSS_ACCESS_KEY_SECRET?.trim();
  const stsToken = env.OSS_SECURITY_TOKEN?.trim();
  if (!regionValue || !bucket || !accessKeyId || !accessKeySecret) configurationError();
  const region = regionValue.startsWith('oss-') ? regionValue : `oss-${regionValue}`;
  // 只接受地域标识，不接受任意 endpoint、URL、internal 或 accelerate 地址。
  if (!/^oss-[a-z]{2}-[a-z]+(?:-[a-z]+)*(?:-\d+)?$/.test(region)
    || region.endsWith('-internal') || region.length > 63
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) configurationError();
  return {
    region, bucket, accessKeyId, accessKeySecret,
    ...(stsToken ? { stsToken } : {}),
    secure: true, authorizationV4: true, timeout: 15_000,
  };
}

function invalidIcon(): never {
  throw new HttpError(400, 'INVALID_SUBMISSION_ICON', '附件必须为有效的 PNG、JPEG、WebP 或 GIF 图片。');
}

function parseIcon(iconData: string): { body: Buffer; mime: string; extension: string } {
  if (typeof iconData !== 'string') invalidIcon();
  if (iconData.length > MAX_BASE64_LENGTH + 32) {
    throw new HttpError(413, 'SUBMISSION_ICON_TOO_LARGE', '附件必须小于 1 MiB。');
  }
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(iconData);
  if (!match) invalidIcon();
  const [, format, encoded] = match;
  if (encoded.length % 4 !== 0) invalidIcon();
  const body = Buffer.from(encoded, 'base64');
  // Buffer 解码本身过于宽松；重编码同时校验填充数量和末尾未使用位。
  if (body.length === 0 || body.toString('base64') !== encoded) invalidIcon();
  if (body.length >= MAX_ICON_BYTES) {
    throw new HttpError(413, 'SUBMISSION_ICON_TOO_LARGE', '附件必须小于 1 MiB。');
  }
  const validMagic = format === 'png'
    ? body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : format === 'jpeg'
      ? body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff
      : format === 'gif'
        ? ['GIF87a', 'GIF89a'].includes(body.subarray(0, 6).toString('latin1'))
        : body.length >= 16 && body.subarray(0, 4).equals(Buffer.from('RIFF'))
          && body.subarray(8, 12).equals(Buffer.from('WEBP'))
          && ['VP8 ', 'VP8L', 'VP8X'].includes(body.subarray(12, 16).toString('latin1'));
  if (!validMagic) invalidIcon();
  return { body, mime: `image/${format}`, extension: format === 'jpeg' ? 'jpg' : format };
}

async function sdkClient(options: OssConfig): Promise<OssClient> {
  const { default: OSS } = await import('ali-oss');
  return new OSS(options);
}

/** 注入 fake 客户端与时钟即可离线测试；生产始终由服务端生成 UUID。 */
export function createOssStorage(dependencies: {
  env?: Environment;
  clientFactory?: ClientFactory;
  now?: () => Date;
} = {}) {
  const clientFactory = dependencies.clientFactory ?? sdkClient;
  const now = dependencies.now ?? (() => new Date());
  return {
    async uploadSubmissionIcon(iconData: string): Promise<{ key: string; url: string }> {
      const { body, mime, extension } = parseIcon(iconData);
      const config = readOssConfig(dependencies.env ?? process.env);
      try {
        const date = now();
        const year = String(date.getUTCFullYear()).padStart(4, '0');
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const key = `site-submissions/${year}/${month}/${randomUUID()}.${extension}`;
        const client = await clientFactory(config);
        await client.put(key, body, {
          headers: { 'Content-Type': mime, 'x-oss-object-acl': 'private' },
        });
        // 忽略 SDK 返回的 URL，绝不签名，也不将 SDK 响应或凭据传出。
        return { key, url: `https://${config.bucket}.${config.region}.aliyuncs.com/${key}` };
      } catch {
        throw new HttpError(502, 'OSS_UPLOAD_FAILED', '附件上传失败，请稍后重试。');
      }
    },
    async deleteSubmissionIcon(key: string): Promise<void> {
      if (typeof key !== 'string' || key.length > 100 || !KEY_PATTERN.test(key)) {
        throw new HttpError(400, 'INVALID_SUBMISSION_ICON_KEY', '附件标识无效。');
      }
      const config = readOssConfig(dependencies.env ?? process.env);
      try {
        const client = await clientFactory(config);
        await client.delete(key);
      } catch {
        throw new HttpError(502, 'OSS_DELETE_FAILED', '附件删除失败，请稍后重试。');
      }
    },
  };
}

export const { uploadSubmissionIcon, deleteSubmissionIcon } = createOssStorage();

