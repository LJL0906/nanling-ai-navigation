import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubmissionGate, fetchSubmissionJson } from '../src/scripts/submission-request.ts';

test('首击立即执行，进行中拒绝重复，快速失败后的800ms内仍防连击', () => {
  let time = 1000;
  const gate = createSubmissionGate(() => time, () => 'key');
  assert.equal(gate.start(), true);
  time = 5000;
  assert.equal(gate.start(), false);
  gate.finish();
  assert.equal(gate.start(), true);
  gate.finish();
  time += 799;
  assert.equal(gate.start(), false);
  time++;
  assert.equal(gate.start(), true);
});

test('同一内容重试复用key，修改内容或完成后重置生成新key', () => {
  let sequence = 0;
  const gate = createSubmissionGate(Date.now, () => `key-${++sequence}`);
  assert.equal(gate.keyFor('{"name":"a"}'), 'key-1');
  gate.finish();
  assert.equal(gate.keyFor('{"name":"a"}'), 'key-1');
  assert.equal(gate.keyFor('{"name":"b"}'), 'key-2');
  gate.reset();
  assert.equal(gate.keyFor('{"name":"b"}'), 'key-3');
});

test('请求正确透传方法/幂等头，解析成功响应', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/submissions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['Idempotency-Key'], 'test-key');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ data: { id: 'saved', status: 'pending' } }, { status: 201 });
  });
  assert.equal((await fetchSubmissionJson('/api/submissions', { method: 'POST', headers: { 'Idempotency-Key': 'test-key' } })).data.id, 'saved');
});

test('网络错误、非法响应和服务错误均可恢复且不伪报成功', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(fetchSubmissionJson('/test'), /网络连接失败/);
  mock.mock.mockImplementation(async () => new Response('<html>bad gateway</html>', {status:502}));
  await assert.rejects(fetchSubmissionJson('/test'), /服务响应异常/);
  mock.mock.mockImplementation(async () => Response.json({error:{message:'提交过于频繁'}}, {status:429}));
  await assert.rejects(fetchSubmissionJson('/test'), /提交过于频繁/);
});

test('慢请求超时可恢复，不误称服务端未保存；响应体卡住同样受限', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (_url, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once:true});
  }));
  await assert.rejects(fetchSubmissionJson('/slow', {}, 10), /结果尚未确认/);
  mock.mock.mockImplementation(async (_url, {signal}) => ({ok:true, json: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {once:true});
  }) }));
  await assert.rejects(fetchSubmissionJson('/slow-body', {}, 10), /结果尚未确认/);
});

test('成功后关闭浮层并显示简短toast，失败不关闭，切页清理定时器', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../src/scripts/site-submission.ts', import.meta.url), 'utf8');
  const component = await readFile(new URL('../src/components/layout/SiteSubmission.astro', import.meta.url), 'utf8');
  const success = source.slice(source.indexOf("if (result.data?.status !== 'pending'"), source.indexOf('needsLogin = auth.unauthorized'));
  assert.match(success, /throw new Error/);
  assert.match(success, /submitted = true;\s+if \(!disposed\) \{\s+dialog.close\(\);\s+showSuccessToast\(\);/);
  assert.ok(!success.includes('message.focus()'));
  assert.match(source, /toast.textContent = '提交成功'/);
  assert.match(source, /setTimeout\(hideToast, 3000\)/);
  assert.match(source, /clearTimeout\(toastTimer\)/);
  assert.match(source, /auth.dispose\(\);\s+hideToast\(\)/);
  assert.match(source, /if \(submitted\) resetForm\(\)/);
  assert.match(component, /data-submission-toast role="status" aria-live="polite"/);
  assert.ok(!component.includes('审核状态与原因'));
});
