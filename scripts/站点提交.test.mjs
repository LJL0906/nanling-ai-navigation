import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { registerHooks } from 'node:module';
import { MAX_BODY_BYTES, MAX_ICON_BYTES, validateSubmission, createSubmissionLimiter,
  saveSubmission, createLegacySubmissionHandler as createSubmissionHandler } from '../src/server/site-submissions.ts';

const categories = [{ id: 'category_ai' }];
const valid = { categoryId: 'category_ai', customCategory: '', name: '测试站点',
  url: 'https://example.test/path', iconUrl: '', iconData: '' };
const check = (patch = {}) => validateSubmission({ ...valid, ...patch }, categories);
const invalid = (patch) => assert.throws(() => check(patch), (error) => error.status === 400);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0l8AAAAASUVORK5CYII=', 'base64');
const image = (type, bytes) => `data:image/${type};base64,${bytes.toString('base64')}`;
const request = (data = valid, headers = {}) => new Request('https://example.test/api/submissions', {
  method: 'POST', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json', ...headers },
  body: typeof data === 'string' ? data : JSON.stringify(data),
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nav-submission-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, handle: createSubmissionHandler({ directory, getCategories: async () => categories }) };
}
async function expectError(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ['error']);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return body;
}

test('接受已有分类和自定义分类，规范空白及 URL', () => {
  assert.deepEqual(check(), valid);
  assert.equal(check({ name: ' 测试 ', url: 'HTTP://EXAMPLE.TEST' }).url, 'http://example.test/');
  assert.equal(check({ categoryId: '', customCategory: ' 新分类 ' }).customCategory, '新分类');
  assert.equal(check({ iconUrl: 'https://example.test/icon.png' }).iconUrl, 'https://example.test/icon.png');
});

test('严格校验对象、六个字符串字段及未知字段', () => {
  for (const input of [null, [], 42, 'text', {}]) {
    assert.throws(() => validateSubmission(input, categories), (error) => error.status === 400);
  }
  for (const field of Object.keys(valid)) {
    for (const value of [null, 1, {}, [], false, undefined]) invalid({ [field]: value });
  }
  invalid({ status: 'approved' });
  invalid({ id: '../../escape' });
});

test('分类必须二选一且精确匹配现有 ID，名称有长度限制', () => {
  for (const patch of [
    { categoryId: '' }, { customCategory: '新分类' }, { categoryId: 'ai' }, { categoryId: '../escape' },
    { categoryId: 'missing' }, { categoryId: '', customCategory: ' ' },
    { categoryId: '', customCategory: 'a'.repeat(51) }, { categoryId: '', customCategory: 'a\nb' },
    { name: '' }, { name: ' ' }, { name: 'a'.repeat(101) }, { name: 'a\u0000b' },
  ]) invalid(patch);
  assert.equal(check({ name: 'a'.repeat(100) }).name.length, 100);
  assert.equal(check({ categoryId: '', customCategory: 'a'.repeat(50) }).customCategory.length, 50);
});

test('站点及图标 URL 仅接受无凭据 http/https', () => {
  for (const url of ['', 'javascript:alert(1)', 'data:text/html,x', 'file:///tmp/x', 'ftp://example.test',
    '//example.test', '/relative', 'https://', 'https:example.test', 'https://user:pass@example.test',
    'https://exam\nple.test', 'https://example.test/' + 'x'.repeat(2048)]) {
    invalid({ url });
    if (url) invalid({ iconUrl: url });
  }
  assert.equal(check({ url: 'http://example.test' }).url, 'http://example.test/');
});

test('四种图片签名均可接受，图标二选一也可都空', () => {
  const webp = Buffer.alloc(20);
  webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBP', 8);
  for (const [type, bytes] of [['png', png], ['jpeg', Buffer.from([255, 216, 255, 224])],
    ['gif', Buffer.from('GIF89a')], ['gif', Buffer.from('GIF87a')], ['webp', webp]]) {
    const iconData = image(type, bytes);
    assert.equal(check({ iconData }).iconData, iconData);
  }
  invalid({ iconData: image('png', png), iconUrl: 'https://example.test/icon.png' });
});

test('拒绝非法 base64、非白名单 MIME、伪造签名和 WebP 长度', () => {
  for (const iconData of [image('svg+xml', Buffer.from('<svg/>')), image('jpg', png), image('jpeg', png),
    image('png', Buffer.from('not an image')), 'data:image/png;base64,!!!!', 'data:image/png;base64,',
    image('png', png).replace(/=$/, ''), image('png', png) + '\n', png.toString('base64'),
    'data:image/png;base64,AB==', image('webp', Buffer.from('RIFFxxxxWEBP'))]) invalid({ iconData });
});

test('图片解码后严格小于 1MiB，边界内接受，等于或超过拒绝', () => {
  for (const size of [MAX_ICON_BYTES - 1, MAX_ICON_BYTES, MAX_ICON_BYTES + 1]) {
    const bytes = Buffer.alloc(size); png.copy(bytes, 0, 0, 8);
    const iconData = image('png', bytes);
    if (size < MAX_ICON_BYTES) assert.equal(check({ iconData }).iconData, iconData);
    else invalid({ iconData });
  }
});

test('201 前记录已持久落盘，仅返回 pending ID，文件名不来自输入', async (t) => {
  const { directory, handle } = await fixture(t);
  const response = await handle(request({ ...valid, name: '../../站点' }), 'client');
  assert.equal(response.status, 201);
  const { data } = await response.json();
  assert.deepEqual(Object.keys(data).sort(), ['id', 'status']);
  assert.equal(data.status, 'pending');
  assert.match(data.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(await readdir(directory), [`${data.id}.json`]);
  const record = JSON.parse(await readFile(join(directory, `${data.id}.json`), 'utf8'));
  assert.equal(record.name, '../../站点');
  assert.equal(record.iconData, '');
  assert.equal(record.status, 'pending');
  assert.equal(record.id, data.id);
  assert.ok(Number.isFinite(Date.parse(record.createdAt)));
  assert.ok(!('clientAddress' in record));
  if (process.platform !== 'win32') assert.equal((await stat(join(directory, `${data.id}.json`))).mode & 0o777, 0o600);
});

test('并发保存不覆盖，嵌套目录自动创建，无临时文件遗留', async (t) => {
  const { directory } = await fixture(t);
  const nested = join(directory, 'nested', 'pending');
  const records = await Promise.all(Array.from({ length: 12 }, () => saveSubmission(valid, nested)));
  assert.equal(new Set(records.map(({ id }) => id)).size, 12);
  assert.equal((await readdir(nested)).length, 12);
  assert.ok((await readdir(nested)).every((name) => name.endsWith('.json')));
});

test('默认目录相对运行 cwd，NAV_SUBMISSIONS_DIR 可覆盖', async (t) => {
  const { directory } = await fixture(t);
  const module = new URL('../src/server/site-submissions.ts', import.meta.url).href;
  for (const configured of ['', 'configured/pending', join(directory, 'absolute-pending')]) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import { saveSubmission } from ${JSON.stringify(module)}; await saveSubmission(${JSON.stringify(valid)});`],
    { cwd: directory, env: { ...process.env, NAV_SUBMISSIONS_DIR: configured }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const root = resolve(directory, configured || '.data/site-submissions');
    assert.equal((await readdir(root)).filter((name) => name.endsWith('.json')).length, 1);
  }
});

test('落盘失败返回通用 500，不泄露内部路径，也不返回伪成功', async (t) => {
  const { directory } = await fixture(t);
  const blocked = join(directory, 'private-storage-secret');
  await writeFile(blocked, 'not a directory');
  const handle = createSubmissionHandler({ directory: blocked, getCategories: async () => categories });
  const original = console.error; console.error = () => {};
  try {
    const body = await expectError(await handle(request(), 'client'), 500, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('private-storage-secret'));
    assert.equal(await readFile(blocked, 'utf8'), 'not a directory');
  } finally { console.error = original; }
});

test('缺失、null、异源、同站不同子域 Origin 和非同源 Fetch Metadata 均拒绝', async (t) => {
  const { handle, directory } = await fixture(t);
  for (const origin of ['', 'null', 'https://evil.test', 'https://sub.example.test', 'http://example.test', 'https://example.test:444']) {
    await expectError(await handle(request(valid, { Origin: origin }), 'client'), 403, 'INVALID_ORIGIN');
  }
  const missing = request(); missing.headers.delete('origin');
  await expectError(await handle(missing, 'client'), 403, 'INVALID_ORIGIN');
  for (const site of ['cross-site', 'same-site', 'none']) {
    await expectError(await handle(request(valid, { 'Sec-Fetch-Site': site }), 'client'), 403, 'INVALID_ORIGIN');
  }
  assert.deepEqual(await readdir(directory), []);
  assert.equal((await handle(request(valid, { 'Sec-Fetch-Site': 'same-origin' }), 'client')).status, 201);
});

test('拒绝错误 Content-Type、压缩体、损坏 JSON 和无效 UTF-8', async (t) => {
  const { handle, directory } = await fixture(t);
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    await expectError(await handle(request(valid, { 'Content-Type': type }), type), 415, 'UNSUPPORTED_MEDIA_TYPE');
  }
  await expectError(await handle(request(valid, { 'Content-Encoding': 'gzip' }), 'gzip'), 415, 'UNSUPPORTED_MEDIA_TYPE');
  for (const text of ['', '{oops']) await expectError(await handle(request(text), text), 400, 'INVALID_SUBMISSION');
  const badUtf = new Request(request(), { body: Buffer.from([0xff]) });
  await expectError(await handle(badUtf, 'utf'), 400, 'INVALID_SUBMISSION');
  assert.deepEqual(await readdir(directory), []);
});

test('请求上限使用实际字节数，接受恰好上限，拒绝超限与虚假 Content-Length', async (t) => {
  const { handle } = await fixture(t);
  const text = JSON.stringify(valid);
  const padded = text + ' '.repeat(MAX_BODY_BYTES - Buffer.byteLength(text));
  assert.equal((await handle(request(padded), 'boundary')).status, 201);
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Content-Length': String(MAX_BODY_BYTES + 1) }]) {
    await expectError(await handle(request(padded + ' ', headers), JSON.stringify(headers)), 413, 'PAYLOAD_TOO_LARGE');
  }
  await expectError(await handle(request(valid, { 'Content-Length': '-1' }), 'negative'), 413, 'PAYLOAD_TOO_LARGE');
  const bytes = Buffer.from('中'.repeat(Math.ceil(MAX_BODY_BYTES / 3) + 1));
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 100)); controller.enqueue(bytes.subarray(100)); },
    cancel() { cancelled = true; },
  });
  const streamed = new Request('https://example.test/api/submissions', { method: 'POST', duplex: 'half',
    headers: { Origin: 'https://example.test', 'Content-Type': 'application/json' }, body: stream });
  await expectError(await handle(streamed, 'stream'), 413, 'PAYLOAD_TOO_LARGE');
  assert.equal(cancelled, true);
});

test('非法分类不会存储，校验错误计入限流，伪造转发 IP 无法绕过', async (t) => {
  const { handle, directory } = await fixture(t);
  for (let i = 0; i < 5; i++) {
    await expectError(await handle(request({ ...valid, categoryId: 'missing' }, { 'X-Forwarded-For': `ip-${i}` }), 'same-client'), 400, 'INVALID_SUBMISSION');
  }
  await expectError(await handle(request(), 'same-client'), 429, 'RATE_LIMITED');
  assert.deepEqual(await readdir(directory), []);
});

test('限流按地址隔离，窗口到期恢复，未知地址共享桶，容量有界', () => {
  let now = 1000;
  const limit = createSubmissionLimiter(() => now);
  for (let i = 0; i < 5; i++) limit('client');
  assert.throws(() => limit('client'), (error) => error.status === 429);
  assert.doesNotThrow(() => limit('other'));
  now += 600000;
  assert.doesNotThrow(() => limit('client'));
  for (let i = 0; i < 5; i++) limit('');
  assert.throws(() => limit(''), (error) => error.status === 429);
  const bounded = createSubmissionLimiter(() => now);
  for (let i = 0; i < 10000; i++) bounded(`ip-${i}`);
  assert.throws(() => bounded('overflow'), (error) => error.status === 429);
  now += 600000;
  assert.doesNotThrow(() => bounded('overflow'));
});

test('生产路由匿名先401，不读取分类或写MySQL；非POST405', async () => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '../../lib/data' && context.parentURL?.endsWith('/api/submissions.ts')) {
        return { url: 'data:text/javascript,' + encodeURIComponent(`export async function getNavigation() { throw new Error('anonymous must not read categories'); }`), shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
  try {
    const { POST, ALL, prerender } = await import('../src/pages/api/submissions.ts');
    assert.equal(prerender, false);
    await expectError(await POST({ request: request(), clientAddress: 'route-client' }), 401, 'USER_UNAUTHORIZED');
    await expectError(await POST({ request: request({}), get clientAddress() { throw new Error('unavailable'); } }), 401, 'USER_UNAUTHORIZED');
    const unsupported = ALL();
    await expectError(unsupported, 405, 'METHOD_NOT_ALLOWED');
    assert.equal(unsupported.headers.get('Allow'), 'POST');
  } finally { hooks.deregister(); }
});

test('上传图标先写 OSS，记录保存对象标识和 URL 而非 base64', async (t) => {
  const { directory } = await fixture(t);
  let uploads = 0;
  const iconObject = { key: 'site-submissions/2026/09/test.png', url: 'https://bucket.oss-cn-beijing.aliyuncs.com/site-submissions/2026/09/test.png' };
  const handle = createSubmissionHandler({ directory, getCategories: async () => categories,
    uploadIcon: async (data) => { uploads++; assert.equal(data, image('png', png)); return iconObject; } });
  const response = await handle(request({ ...valid, iconData: image('png', png) }), 'upload');
  assert.equal(response.status, 201);
  const { data } = await response.json();
  const stored = JSON.parse(await readFile(join(directory, `${data.id}.json`), 'utf8'));
  assert.equal(uploads, 1);
  assert.equal(stored.iconData, '');
  assert.equal(stored.iconUrl, iconObject.url);
  assert.deepEqual(stored.iconObject, { provider: 'oss', key: iconObject.key });
  assert.equal(JSON.stringify(stored).includes(png.toString('base64')), false);
  assert.deepEqual(Object.keys(data).sort(), ['id', 'status']);
});

test('在线图标或无图标不调用 OSS，不依赖 OSS 配置', async (t) => {
  const { directory } = await fixture(t);
  const handle = createSubmissionHandler({ directory, getCategories: async () => categories,
    uploadIcon: async () => { throw new Error('不应上传'); } });
  for (const iconUrl of ['', 'https://example.test/icon.png']) {
    assert.equal((await handle(request({ ...valid, iconUrl }), 'url')).status, 201);
  }
});

test('无效图片在 OSS 调用前拒绝，上传失败不落盘也不泄漏异常', async (t) => {
  const { directory } = await fixture(t);
  let uploads = 0;
  const handle = createSubmissionHandler({ directory, getCategories: async () => categories,
    uploadIcon: async () => { uploads++; throw new Error('secret-should-not-leak'); } });
  await expectError(await handle(request({ ...valid, iconData: 'data:image/png;base64,aGVsbG8=' }), 'invalid'), 400, 'INVALID_SUBMISSION');
  assert.equal(uploads, 0);
  const response = await handle(request({ ...valid, iconData: image('png', png) }), 'failure');
  const body = await expectError(response, 500, 'INTERNAL_ERROR');
  assert.equal(JSON.stringify(body).includes('secret-should-not-leak'), false);
  assert.equal(uploads, 1);
  assert.deepEqual(await readdir(directory), []);
});


test('备注选填，支持多行并规范换行，限制500字与字段类型', () => {
  assert.deepEqual(check({ remark: '' }), check());
  assert.deepEqual(check({ remark: '   ' }), check());
  assert.equal(check({ remark: ' 推荐理由\r\n第二行 ' }).remark, '推荐理由\n第二行');
  assert.equal(check({ remark: '字'.repeat(500) }).remark.length, 500);
  for (const remark of [null, 1, false, {}, [], '字'.repeat(501), 'a\u0000b']) invalid({ remark });
});

test('备注随记录保存，修改备注不能用原幂等键覆盖，空备注兼容旧提交', async (t) => {
  const { directory, handle } = await fixture(t);
  const headers = { 'Idempotency-Key': 'd34603c9-c664-4e7d-a232-067e8c562c32' };
  const response = await handle(request({ ...valid, remark: '免费工具\n支持中文' }, headers), 'remark');
  assert.equal(response.status, 201);
  const { data } = await response.json();
  const record = JSON.parse(await readFile(join(directory, `${data.id}.json`), 'utf8'));
  assert.equal(record.remark, '免费工具\n支持中文');
  assert.equal((await handle(request({ ...valid, remark: '其他说明' }, headers), 'remark')).status, 409);
  assert.equal((await readdir(directory)).length, 1);
  const emptyHeaders = { 'Idempotency-Key': '8643e7d7-44da-4896-bcba-b945b7213dcd' };
  const first = await handle(request(valid, emptyHeaders), 'empty');
  const second = await handle(request({ ...valid, remark: '' }, emptyHeaders), 'empty');
  assert.deepEqual(await first.json(), await second.json());
});


