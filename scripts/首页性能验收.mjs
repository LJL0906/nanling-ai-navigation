/** 只读生产构建验收；不读取/输出凭据，不修改数据库。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
const root = fileURLToPath(new URL('../', import.meta.url));
const driver = process.argv.includes('--mysql') ? 'mysql' : 'seed';
const buildDir = process.env.NAV_BUILD_DIR ?? 'dist';
const port = await new Promise(resolve => {
  const listener = createServer();
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, [`${buildDir}/server/entry.mjs`], {
  cwd: root, windowsHide: true, stdio: 'ignore',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), NAV_STORAGE: driver },
});
const rounded = n => Math.round(n * 100) / 100;
async function measure(path, headers) {
  const started = performance.now();
  const response = await fetch(base + path, { headers, signal: AbortSignal.timeout(20_000) });
  const firstByteMs = performance.now() - started;
  const body = await response.text();
  return { status: response.status, firstByteMs: rounded(firstByteMs), totalMs: rounded(performance.now() - started),
    bytes: Buffer.byteLength(body), etag: response.headers.get('etag'), cacheControl: response.headers.get('cache-control'), body };
}
const summary = ({ body, ...entry }) => entry;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { await fetch(base + '/logo.png', { signal: AbortSignal.timeout(500) }); ready = true; break; }
    catch { if (server.exitCode !== null) throw new Error('生产服务启动失败'); await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert.ok(ready, '生产服务启动超时');
  const cold = await measure('/'); assert.equal(cold.status, 200, '首页应成功返回');
  const cards = [...cold.body.matchAll(/<section\b[^>]*data-home-section[^>]*>[\s\S]*?<\/section>/g)]
    .reduce((sum, match) => sum + (match[0].match(/data-site-id=/g) ?? []).length, 0);
  assert.ok(cards > 0 && cards <= 18 * 18, '首页只渲染各分区首批卡片');
  assert.ok(cold.bytes < 2_000_000, '首页HTML体积应低于2MB');
  const warm = [];
  for (let i = 0; i < 5; i++) warm.push(summary(await measure('/')));
  const concurrent = await Promise.all(Array.from({ length: 5 }, async () => summary(await measure('/'))));
  for (const result of [...warm, ...concurrent]) assert.equal(result.status, 200);
  const pages = {};
  for (const path of ['/favorites/', '/admin/login/']) {
    const result = await measure(path); assert.equal(result.status, 200, path); pages[path] = summary(result);
  }
  const indices = {};
  for (const path of ['/search-index.json', '/personal-sites.json', '/history-destinations.json']) {
    const initial = await measure(path); assert.equal(initial.status, 200, path); assert.ok(initial.etag, '公开索引应有ETag');
    const validated = await measure(path, { 'If-None-Match': initial.etag });
    assert.equal(validated.status, 304, path); assert.equal(validated.bytes, 0, '304不重复传输索引');
    indices[path] = { initial: summary(initial), validated: summary(validated) };
  }
  const report = { measuredAt: new Date().toISOString(), environment: '本机Node生产构建，回环网络；非公网测速', driver,
    initialCards: cards, cold: summary(cold), warmMedianMs: [...warm].sort((a,b) => a.totalMs-b.totalMs)[2].totalMs,
    warm, concurrent, pages, indices };
  await mkdir(new URL('../reports/', import.meta.url), { recursive: true });
  const file = new URL(`../reports/首页性能验收-${driver}.json`, import.meta.url);
  await writeFile(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  server.kill();
}
