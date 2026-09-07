import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createLegacySubmissionHandler as createSubmissionHandler } from '../src/server/site-submissions.ts';

const categories = [{ id: 'ai' }];
const valid = { categoryId: 'ai', customCategory: '', name: '测试站点',
  url: 'https://example.test/', iconUrl: '', iconData: 'data:image/png;base64,iVBORw0KGgo=' };
function request(key, data = valid, headers = {}) {
  return new Request('https://example.test/api/submissions', {
    method: 'POST', headers: { origin: 'https://example.test', 'content-type': 'application/json',
      ...(key === undefined ? {} : { 'Idempotency-Key': key }), ...headers },
    body: JSON.stringify(data),
  });
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function fixture(t, uploader) {
  const directory = await mkdtemp(join(tmpdir(), 'nav-idempotency-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let uploads = 0;
  const options = { directory, getCategories: async () => categories, uploadIcon: async data => {
    uploads++;
    return uploader ? uploader(data, uploads, directory) : { key: 'fake/icon.png', url: 'https://oss.test/icon.png' };
  } };
  return { directory, options, handle: createSubmissionHandler(options), uploads: () => uploads };
}
async function body(response, status = 201) {
  assert.equal(response.status, status);
  return response.json();
}

test('同进程跨 handler 并发合并：仅上传一次、仅一个原记录，所有响应独立可读', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async () => {
    entered.resolve(); await release.promise;
    return { key: 'fake/icon.png', url: 'https://oss.test/icon.png' };
  });
  const key = randomUUID();
  const first = f.handle(request(key), 'client');
  await entered.promise;
  const other = createSubmissionHandler(f.options);
  const duplicates = Array.from({ length: 12 }, () => other(request(key), 'client'));
  await body(await other(request(key, { ...valid, name: '其他' }), 'client'), 409);
  release.resolve();
  const responses = await Promise.all([first, ...duplicates]);
  const results = await Promise.all(responses.map(r => body(r)));
  for (const result of results) assert.deepEqual(result, results[0]);
  assert.equal(f.uploads(), 1);
  assert.deepEqual(await readdir(f.directory), [`${key}.json`]);
  const record = JSON.parse(await readFile(join(f.directory, `${key}.json`), 'utf8'));
  assert.equal(record.id, key);
  assert.equal(record.requestKey, key);
  assert.equal(record.requestDigest, createHash('sha256')
    .update(JSON.stringify(Object.keys(valid).sort().map(k => [k, valid[k]]))).digest('hex'));
  assert.equal(record.iconData, '');
  assert.equal(record.iconUrl, 'https://oss.test/icon.png');
});

test('成功重放及规范化：key 大小写、输入顺序/空白/URL 写法不影响；重放不扣限额', async t => {
  const f = await fixture(t), key = randomUUID();
  const first = await body(await f.handle(request(key), 'client'));
  const normalized = { iconData: valid.iconData, iconUrl: '', url: 'HTTPS://EXAMPLE.TEST',
    name: ' 测试站点 ', customCategory: '', categoryId: ' ai ' };
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(await body(await f.handle(request(key.toUpperCase(), normalized), 'client')), first);
  }
  for (let i = 0; i < 4; i++) await body(await f.handle(request(randomUUID()), 'client'));
  await body(await f.handle(request(randomUUID()), 'client'), 429);
  assert.deepEqual(await body(await f.handle(request(key), 'client')), first);
  assert.equal(f.uploads(), 5);
});

test('已保存 key 不同内容 409，修改内容换 key 正常提交', async t => {
  const f = await fixture(t), key = randomUUID();
  await body(await f.handle(request(key), 'client'));
  for (const patch of [{ name: '新名称' }, { url: 'https://other.test/' }, { iconData: '' }]) {
    const error = await body(await f.handle(request(key, { ...valid, ...patch }), 'client'), 409);
    assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT');
  }
  await body(await f.handle(request(randomUUID(), { ...valid, name: '新名称' }), 'client'));
  assert.equal(f.uploads(), 2);
});

test('上传失败并发共享错误，释放进行中状态，原 key 可重试', async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, async (_data, count) => {
    if (count === 1) { entered.resolve(); await release.promise; throw new Error('fake upload failure'); }
    return { key: 'fake/icon.png', url: 'https://oss.test/icon.png' };
  });
  const key = randomUUID();
  const first = f.handle(request(key), 'client');
  await entered.promise;
  const duplicate = f.handle(request(key), 'client');
  // 确保重复请求经过解析并进入等待，不依赖真实 OSS 或计时器。
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  await body(await first, 500); await body(await duplicate, 500);
  assert.equal(f.uploads(), 1);
  assert.deepEqual(await readdir(f.directory), []);
  await body(await f.handle(request(key), 'client'));
  assert.equal(f.uploads(), 2);
});

test('上传后落盘失败不缓存成功，解除磁盘故障后同 key 重试', async t => {
  const f = await fixture(t), key = randomUUID();
  // 用目录阻止临时文件创建；不触及正式运行数据。
  const blocker = join(f.directory, `.${key}.tmp`);
  await mkdir(blocker);
  await body(await f.handle(request(key), 'client'), 500);
  assert.equal(f.uploads(), 1);
  assert.deepEqual(await readdir(f.directory), [`.${key}.tmp`]);
  await rm(blocker, { recursive: true });
  await body(await f.handle(request(key), 'client'));
  await body(await f.handle(request(key), 'client'));
  assert.equal(f.uploads(), 2);
  assert.deepEqual(await readdir(f.directory), [`${key}.json`]);
});

test('缺失 key 保留旧行为：重复内容分别上传、随机 ID、无幂等元数据', async t => {
  const f = await fixture(t);
  const a = await body(await f.handle(request(undefined), 'client'));
  const b = await body(await f.handle(request(undefined), 'client'));
  assert.notEqual(a.data.id, b.data.id);
  assert.equal(f.uploads(), 2);
  for (const name of await readdir(f.directory)) {
    const record = JSON.parse(await readFile(join(f.directory, name), 'utf8'));
    assert.equal(record.requestKey, undefined);
    assert.equal(record.requestDigest, undefined);
  }
});

test('非法 UUID 在上传前拒绝且计入限额，同源保护覆盖重放', async t => {
  const f = await fixture(t);
  for (const key of ['', '../escape', 'no-uuid', randomUUID() + ', ' + randomUUID(),
    '00000000-0000-0000-0000-000000000000', '12345678-1234-4234-7234-123456789abc']) {
    const error = await body(await f.handle(request(key), key || 'empty'), 400);
    assert.equal(error.error.code, 'INVALID_IDEMPOTENCY_KEY');
  }
  assert.equal(f.uploads(), 0);
  for (let i = 0; i < 5; i++) await body(await f.handle(request('invalid'), 'limited'), 400);
  await body(await f.handle(request(randomUUID()), 'limited'), 429);
  const key = randomUUID();
  await body(await f.handle(request(key), 'client'));
  await body(await f.handle(request(key, valid, { origin: 'https://evil.test' }), 'client'), 403);
  await body(await f.handle(request(key, valid, { 'sec-fetch-site': 'cross-site' }), 'client'), 403);
  assert.equal(f.uploads(), 1);
});

test('新 Node 进程重启模拟：从原记录重放同 ID、不上传，冲突仍为 409', async t => {
  const f = await fixture(t), key = randomUUID();
  const first = await body(await f.handle(request(key), 'client'));
  const moduleUrl = new URL('../src/server/site-submissions.ts', import.meta.url).href;
  const script = `
    import { createLegacySubmissionHandler as createSubmissionHandler } from ${JSON.stringify(moduleUrl)};
    const handle = createSubmissionHandler({ directory: ${JSON.stringify(f.directory)},
      getCategories: async () => ${JSON.stringify(categories)},
      uploadIcon: async () => { throw new Error('must not upload'); } });
    const request = ${request.toString()};
    const valid = ${JSON.stringify(valid)};
    const a = await handle(request(${JSON.stringify(key)}), 'client');
    const b = await handle(request(${JSON.stringify(key)}, {...valid, name: 'changed'}), 'client');
    console.log(JSON.stringify([a.status, await a.json(), b.status]));
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [201, first, 409]);
  assert.deepEqual(await readdir(f.directory), [`${key}.json`]);
});

test('记录损坏时失败关闭而不重新上传或覆盖；修复后可重放', async t => {
  const f = await fixture(t), key = randomUUID();
  const first = await body(await f.handle(request(key), 'client'));
  const path = join(f.directory, `${key}.json`);
  const original = await readFile(path, 'utf8');
  for (const corrupt of ['{', JSON.stringify({ id: key }), 'null']) {
    await writeFile(path, corrupt);
    await body(await f.handle(request(key), 'client'), 500);
    assert.equal(await readFile(path, 'utf8'), corrupt);
  }
  assert.equal(f.uploads(), 1);
  await writeFile(path, original);
  assert.deepEqual(await body(await f.handle(request(key), 'client')), first);
});
