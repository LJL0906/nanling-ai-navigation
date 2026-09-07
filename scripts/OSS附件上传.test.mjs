import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOssStorage, readOssConfig } from '../src/server/oss-storage.ts';
import { HttpError } from '../src/server/http.ts';

const env = {
  OSS_REGION: 'cn-beijing', OSS_BUCKET: 'test-icons',
  OSS_ACCESS_KEY_ID: 'fake-id', OSS_ACCESS_KEY_SECRET: 'fake-secret',
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const data = (body = png, format = 'png') => `data:image/${format};base64,${body.toString('base64')}`;
const validKey = 'site-submissions/2026/09/12345678-1234-4123-8123-123456789abc.png';
function fixture(overrides = {}) {
  const calls = [];
  const storage = createOssStorage({
    env, now: () => new Date('2026-09-07T00:00:00Z'),
    clientFactory: (options) => {
      calls.push(['options', options]);
      return {
        put: async (...args) => { calls.push(['put', ...args]); return { url: 'https://unsafe/?secret=fake-secret' }; },
        delete: async (...args) => { calls.push(['delete', ...args]); },
      };
    },
    ...overrides,
  });
  return { ...storage, calls };
}
const isError = (status, code) => (error) => {
  assert.ok(error instanceof HttpError);
  assert.equal(error.status, status);
  if (code) assert.equal(error.code, code);
  assert.equal(error.cause, undefined);
  return true;
};

test('配置：规范地域、HTTPS、V4、15 秒及可选 STS', () => {
  assert.deepEqual(readOssConfig(env), {
    region: 'oss-cn-beijing', bucket: 'test-icons', accessKeyId: 'fake-id',
    accessKeySecret: 'fake-secret', secure: true, authorizationV4: true, timeout: 15000,
  });
  assert.equal(readOssConfig({ ...env, OSS_REGION: 'oss-cn-beijing' }).region, 'oss-cn-beijing');
  assert.equal(readOssConfig({ ...env, OSS_SECURITY_TOKEN: 'fake-sts' }).stsToken, 'fake-sts');
  for (const name of Object.keys(env)) {
    for (const value of [undefined, '', '  ']) {
      assert.throws(() => readOssConfig({ ...env, [name]: value }), isError(503));
    }
  }
  for (const region of ['https://evil.test', 'oss-cn-beijing.evil.test', 'cn-beijing/internal', 'cn-beijing-internal', 'cn-beijing-']) {
    assert.throws(() => readOssConfig({ ...env, OSS_REGION: region }), isError(503));
  }
  for (const bucket of ['ab', 'UPPER', '-test', 'test-', 'test.evil', 'x'.repeat(64)]) {
    assert.throws(() => readOssConfig({ ...env, OSS_BUCKET: bucket }), isError(503));
  }
});

test('上传 Buffer、私有对象 ACL、规范无签名 URL；UUID 不重复', async () => {
  const f = fixture();
  const first = await f.uploadSubmissionIcon(data());
  const second = await f.uploadSubmissionIcon(data());
  assert.match(first.key, /^site-submissions\/2026\/09\/[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.png$/);
  assert.notEqual(first.key, second.key);
  assert.deepEqual(first, { key: first.key, url: `https://test-icons.oss-cn-beijing.aliyuncs.com/${first.key}` });
  assert.deepEqual(f.calls[0], ['options', readOssConfig(env)]);
  assert.deepEqual(f.calls[1], ['put', first.key, png, {
    headers: { 'Content-Type': 'image/png', 'x-oss-object-acl': 'private' },
  }]);
  assert.deepEqual(f.calls.map(c => c[0]), ['options', 'put', 'options', 'put']);
});

test('四种允许格式及 MIME、扩展名一致', async () => {
  for (const [format, body, extension] of [
    ['png', png, 'png'], ['jpeg', Buffer.from([255, 216, 255, 224]), 'jpg'],
    ['gif', Buffer.from('GIF87a1234'), 'gif'], ['gif', Buffer.from('GIF89a1234'), 'gif'],
    ...['VP8 ', 'VP8L', 'VP8X'].map(chunk => ['webp', Buffer.from(`RIFF0000WEBP${chunk}0000`), 'webp']),
  ]) {
    const f = fixture();
    const result = await f.uploadSubmissionIcon(data(body, format));
    assert.ok(result.key.endsWith(`.${extension}`));
    assert.equal(f.calls[1][3].headers['Content-Type'], `image/${format}`);
  }
});

test('拒绝非允许 data URL、非法/非规范 base64 及魔数不符，且不创建客户端', async () => {
  const f = fixture();
  const bad = [null, undefined, 1, '', 'https://example.test/icon.png',
    data(png, 'svg+xml'), data(png, 'jpg'), data(png, 'jpeg'), data(png, 'gif'), data(png, 'webp'),
    'data:image/png;base64,', 'data:image/png;base64,AAAA=',
    'data:image/png;base64,AA=A', 'data:image/png;base64,AA-_',
    data().replace(/.$/, '!'), `${data()}\n`, data().replace('base64,', 'base64, '),
    data().replace('image/png', 'image/png;charset=utf-8'),
    data(Buffer.from('not-an-image')), data(png.subarray(0, 7)),
    data(Buffer.from([0xff, 0xd8]), 'jpeg'),
    data(Buffer.from('RIFF0000WEBPbad!'), 'webp'),
    data(Buffer.from('RIFF0000WEBP'), 'webp'),
    data(Buffer.from([0xc7, 0x49, 0x46, 0x38, 0x39, 0x61]), 'gif'),
    // 相同解码字节，但末尾未使用位非零。
    data(Buffer.concat([png, Buffer.from([0])])).replace('AA==', 'AB=='),
  ];
  for (const value of bad) await assert.rejects(f.uploadSubmissionIcon(value), isError(400));
  assert.equal(f.calls.length, 0);
});

test('体积严格小于 1 MiB（解码后）；过大输入提前拒绝', async () => {
  const f = fixture();
  for (const size of [1024 * 1024 - 1, 1024 * 1024, 1024 * 1024 + 1]) {
    const body = Buffer.alloc(size); png.copy(body);
    if (size < 1024 * 1024) await f.uploadSubmissionIcon(data(body));
    else await assert.rejects(f.uploadSubmissionIcon(data(body)), isError(413));
  }
  await assert.rejects(f.uploadSubmissionIcon('x'.repeat(2 * 1024 * 1024)), isError(413));
  assert.equal(f.calls.filter(c => c[0] === 'put').length, 1);
});

test('缺失配置映射 503，不创建客户端', async () => {
  const f = fixture({ env: {} });
  await assert.rejects(f.uploadSubmissionIcon(data()), isError(503));
  await assert.rejects(f.deleteSubmissionIcon(validKey), isError(503));
  assert.equal(f.calls.length, 0);
});

test('SDK 构造、上传、删除异常均转通用错误，不泄漏也不记录原始异常', async (t) => {
  const logs = [];
  for (const method of ['error', 'warn', 'log', 'info', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args));
  }
  const secret = 'SDK fake-secret https://signed.test/?signature=private fake-sts';
  for (const constructFails of [true, false]) {
    const f = fixture({ clientFactory: () => {
      if (constructFails) throw new Error(secret);
      return { put: async () => { throw new Error(secret); }, delete: async () => { throw new Error(secret); } };
    } });
    for (const [action, code] of [
      [() => f.uploadSubmissionIcon(data()), 'OSS_UPLOAD_FAILED'],
      [() => f.deleteSubmissionIcon(validKey), 'OSS_DELETE_FAILED'],
    ]) {
      await assert.rejects(action(), error => {
        isError(502, code)(error);
        assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /fake-secret|signed\.test|fake-sts/);
        return true;
      });
    }
  }
  assert.deepEqual(logs, []);
});

test('删除仅允许受限前缀、有效月份、v4 UUID、小写图片扩展名', async () => {
  const f = fixture();
  for (const key of [null, '', 'other/icon.png', `/${validKey}`, `${validKey}\n`,
    validKey.replace('/09/', '/00/'), validKey.replace('/09/', '/13/'),
    validKey.replace('2026', '26'), validKey.replace('-4123-', '-1123-'),
    validKey.replace('-8123-', '-7123-'), validKey.replace('.png', '.svg'),
    validKey.replace('.png', '.PNG'), `${validKey}?x=1`, `${validKey}/../a`,
    validKey.replace('site-submissions/', 'site-submissions/../'),
    validKey.replace('/09/', '%2F09%2F'), 'x'.repeat(1000),
  ]) await assert.rejects(f.deleteSubmissionIcon(key), isError(400));
  assert.equal(f.calls.length, 0);
  for (const ext of ['png', 'jpg', 'webp', 'gif']) {
    const key = validKey.replace('.png', `.${ext}`);
    assert.equal(await f.deleteSubmissionIcon(key), undefined);
    assert.deepEqual(f.calls.at(-1), ['delete', key]);
  }
});
