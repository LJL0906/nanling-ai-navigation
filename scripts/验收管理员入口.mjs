import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = await new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const token = randomBytes(32).toString('hex');
const base = `http://127.0.0.1:${port}`;
const request = (path, options) => fetch(base + path, options);
const child = spawn(process.execPath, ['dist/server/entry.mjs'], { cwd: root, windowsHide: true,
  env: { ...process.env, NAV_STORAGE: 'seed', HOST: '127.0.0.1', PORT: String(port),
    ADMIN_TOKEN: token, ADMIN_USERNAME: 'build-admin', ADMIN_PASSWORD: token }, stdio: 'pipe' });
let output = '';
child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await request('/api/health')).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, `服务未就绪：${output}`);
  const settings = await request('/settings/', { redirect: 'manual' });
  assert.equal(settings.status, 302);
  assert.equal(settings.headers.get('location'), '/admin/login/');
  for (const path of ['/admin/', '/admin/sites/', '/admin/categories/', '/admin/menus/', '/admin/reviews/']) {
    const locked = await request(path, { redirect: 'manual' });
    assert.equal(locked.status, 302, path + ' 未登录应跳转');
    assert.ok(locked.headers.get('location').startsWith('/admin/login/'));
  }
  const login = await request('/api/admin/session', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username: 'build-admin', password: token }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly'));
  const entry = await request('/admin/', { redirect: 'manual', headers: { Cookie: cookie } });
  assert.equal(entry.status, 302);
  assert.equal(entry.headers.get('location'), '/admin/sites/');
  for (const [path, marker] of [ ['/admin/sites/', 'data-admin-root'], ['/admin/categories/', 'data-category-admin-root'], ['/admin/menus/', 'data-menu-admin'], ['/admin/reviews/', '审核']]) {
    const response = await request(path, { redirect: 'manual', headers: { Cookie: cookie } });
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(html.includes(marker), path + ' 应渲染管理工作台');
    assert.ok(!html.includes(token), '密码不能进入页面');
    assert.ok(html.includes('admin-sidebar') && html.includes('admin-topbar'), '独立管理壳必须存在');
    assert.ok(!html.includes('cyber-topbar'), '后台不得嵌入前台顶栏');
  }
  assert.equal((await request('/api/admin/status', { headers: { Cookie: cookie } })).status, 200);
  for (const kind of ['sites', 'categories']) {
    assert.equal((await request(`/api/admin/content?kind=${kind}`)).status, 401);
    const content = await request(`/api/admin/content?kind=${kind}`, { headers: { Cookie: cookie } });
    assert.equal(content.status, 200);
    const result = (await content.json()).data;
    assert.equal(result.writable, false);
    assert.ok(result.items.length > 0);
    assert.match(result.items[0].revision, /^[a-f0-9]{64}$/);
    const removed = await request('/api/admin/content', { method: 'DELETE', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, id: result.items[0].id, revision: result.items[0].revision }) });
    assert.equal(removed.status, 503, 'seed 模式不能修改内容');
  }

  assert.equal((await request('/api/admin/menus', { headers: { Cookie: cookie } })).status, 200);
  const submissionId = '5c6978ef-1f68-4b28-b6ed-86c6a6553629';
  const reviewBody = JSON.stringify({ id: submissionId, status: 'approved', reason: '临时验收记录' });
  assert.equal((await request('/api/admin/submissions', { method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: 'https://evil.test' }, body: reviewBody })).status, 403);
  const review = await request('/api/admin/submissions', { method: 'PATCH',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: base }, body: reviewBody });
  assert.equal(review.status, 503, 'seed 模式必须拒绝发布，不能产生虚假审批成功');
  assert.equal((await review.json()).error.code, 'PUBLISH_STORAGE_READ_ONLY');
  assert.equal((await request('/api/admin/session', { method: 'DELETE', headers: { Cookie: cookie, Origin: base } })).status, 200);
  assert.equal((await request('/api/admin/status', { headers: { Cookie: cookie } })).status, 401);
  console.log('管理员入口回归通过：设置跳转、页面保护、账号登录、跨页面会话、独立后台布局、只读发布保护、跨站拒绝及退出撤销。');
 } finally {
  child.kill();
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
}
