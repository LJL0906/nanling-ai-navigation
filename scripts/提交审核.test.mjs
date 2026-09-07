import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { saveSubmission } from '../src/server/site-submissions.ts';
import { createSubmissionReviewHandler, listSubmissions, reviewSubmission } from '../src/server/submission-review.ts';
import { loginAdmin } from '../src/server/admin-session.ts';

const valid = { categoryId: 'category_ai', customCategory: '', name: '<img src=x onerror=alert(1)>',
  url: 'https://example.test/', iconUrl: '', iconData: '', remark: '<script>备注</script>' };
const origin = 'https://example.test';
const environment = Object.fromEntries(['ADMIN_TOKEN', 'ADMIN_USERNAME', 'ADMIN_PASSWORD'].map(key => [key, process.env[key]]));
let cookie;
before(async () => {
  process.env.ADMIN_TOKEN = 'a'.repeat(40);
  process.env.ADMIN_USERNAME = '审核管理员';
  process.env.ADMIN_PASSWORD = 'review-test-password-only';
  const session = await loginAdmin(new Request(`${origin}/api/admin/session`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) }));
  cookie = session.cookie.split(';')[0];
});
after(() => {
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nav-review-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const handle = createSubmissionReviewHandler({ directory });
  const saved = await saveSubmission(valid, directory);
  return { directory, handle, id: saved.id };
}
function request(body, { query = '', headers = {}, method = body === undefined ? 'GET' : 'PATCH' } = {}) {
  return new Request(`${origin}/api/admin/submissions${query}`, { method,
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
const decision = (id, status = 'approved', reason = '已核对，内容符合要求') => ({ id, status, reason });
async function error(response, status, code) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json(); assert.equal(body.error.code, code);
  return body;
}

test('复用提交落盘目录，默认仅列待审，响应不暴露幂等摘要或图片原始数据', async t => {
  const { directory, handle, id } = await fixture(t);
  const record = JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8'));
  await writeFile(join(directory, `${id}.json`), JSON.stringify({ ...record, requestDigest: 'secret', iconData: 'private' }));
  const response = await handle(request()); assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.items[0].id, id); assert.equal(data.items[0].name, valid.name);
  assert.equal(data.total, 1); assert.equal(data.page, 1); assert.equal(data.pageSize, 20);
  assert.equal(data.items[0].reviewedAt, null); assert.equal(data.items[0].remark, valid.remark);
  assert.equal('requestDigest' in data.items[0], false); assert.equal('iconData' in data.items[0], false);
});

test('通过和拒绝均持久化理由、时间、会话管理员，保留原始字段且不创建入库文件', async t => {
  const { directory, handle, id } = await fixture(t);
  const path = join(directory, `${id}.json`);
  const original = JSON.parse(await readFile(path, 'utf8'));
  original.requestKey = id; original.requestDigest = 'a'.repeat(64); original.iconObject = { provider: 'oss', key: 'test/key' };
  await writeFile(path, JSON.stringify(original));
  const response = await handle(request(decision(id))); assert.equal(response.status, 200);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.status, 'approved'); assert.equal(saved.reviewedBy, '审核管理员');
  assert.equal(saved.reviewReason, '已核对，内容符合要求'); assert.ok(Number.isFinite(Date.parse(saved.reviewedAt)));
  for (const key of Object.keys(original).filter(key => key !== 'status')) assert.deepEqual(saved[key], original[key]);
  assert.deepEqual(await readdir(directory), [`${id}.json`]);
  const second = await saveSubmission(valid, directory);
  await handle(request(decision(second.id, 'rejected', ' 不符合收录要求 ')));
  const rejected = await listSubmissions(new URLSearchParams('status=rejected'), directory);
  assert.equal(rejected.items[0].reviewReason, '不符合收录要求');
  assert.equal((await listSubmissions(new URLSearchParams(), directory)).total, 0);
});

test('重复审批返回409，原审核理由及身份不可覆盖', async t => {
  const { directory, handle, id } = await fixture(t);
  await handle(request(decision(id)));
  const before = await readFile(join(directory, `${id}.json`), 'utf8');
  await error(await handle(request(decision(id, 'rejected', '覆盖尝试'))), 409, 'REVIEW_CONFLICT');
  assert.equal(await readFile(join(directory, `${id}.json`), 'utf8'), before);
});

test('同一记录并发审批只有一次成功，不同记录可以独立审核', async t => {
  const { directory, handle, id } = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => handle(request(decision(id, i % 2 ? 'approved' : 'rejected')))));
  assert.equal(responses.filter(response => response.status === 200).length, 1);
  assert.equal(responses.filter(response => response.status === 409).length, 11);
  const ids = await Promise.all(Array.from({ length: 4 }, () => saveSubmission(valid, directory)));
  const independent = await Promise.all(ids.map(({ id }) => handle(request(decision(id)))));
  assert.ok(independent.every(response => response.status === 200));
  assert.ok((await readdir(directory)).every(name => name.endsWith('.json')));
});

test('跨进程审核互斥，后到进程不能覆盖成功结果', async t => {
  const { directory, id } = await fixture(t);
  const module = new URL('../src/server/submission-review.ts', import.meta.url).href;
  const code = `import { reviewSubmission } from ${JSON.stringify(module)};
    try { await reviewSubmission(JSON.parse(process.argv[1]), process.argv[2]); console.log(200); }
    catch (e) { if (!e.status) console.error(e); console.log(e.status ?? 500); }`;
  const run = status => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code, JSON.stringify(decision(id, status)), directory], { windowsHide: true });
    let output = ''; let stderr = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', exit => exit || stderr ? reject(new Error(stderr)) : resolve(Number(output.trim())));
  });
  assert.deepEqual((await Promise.all([run('approved'), run('rejected'), run('approved')])).sort(), [200, 409, 409]);
});

test('遗留锁失败关闭，不抢锁、不覆盖、不删除他人锁', async t => {
  const { directory, handle, id } = await fixture(t);
  const lock = join(directory, `.${id}.review.lock`); await writeFile(lock, 'locked');
  await error(await handle(request(decision(id))), 409, 'REVIEW_CONFLICT');
  assert.equal(await readFile(lock, 'utf8'), 'locked');
  assert.equal(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).status, 'pending');
});

test('分页确定性排序，筛选互不混入，空目录和越界页返回空数组', async t => {
  const { directory } = await fixture(t);
  await saveSubmission(valid, directory); await saveSubmission(valid, directory);
  const all = await listSubmissions(new URLSearchParams('pageSize=100'), directory);
  const second = await listSubmissions(new URLSearchParams('page=2&pageSize=1'), directory);
  assert.equal(second.total, 3); assert.equal(second.totalPages, 3); assert.equal(second.items[0].id, all.items[1].id);
  assert.deepEqual((await listSubmissions(new URLSearchParams('page=99'), directory)).items, []);
  assert.equal((await listSubmissions(new URLSearchParams('status=approved'), directory)).total, 0);
  assert.equal((await listSubmissions(new URLSearchParams(), join(directory, 'missing'))).total, 0);
});

test('拒绝路径遍历、无效状态、越界分页及重复参数', async t => {
  const { handle, id } = await fixture(t);
  for (const candidate of ['../secret', '..\\secret', '/etc/passwd', '%2e%2e', `${id}/../x`, '', null]) {
    await error(await handle(request(decision(candidate))), 400, 'INVALID_ID');
  }
  for (const query of ['?page=0', '?page=-1', '?page=1.5', '?pageSize=101', '?pageSize=0', '?page=9007199254740993']) {
    await error(await handle(request(undefined, { query })), 400, 'INVALID_PAGINATION');
  }
  await error(await handle(request(undefined, { query: '?status=all' })), 400, 'INVALID_STATUS');
  await error(await handle(request(undefined, { query: '?status=pending&status=approved' })), 400, 'INVALID_QUERY');
  await error(await handle(request(undefined, { query: '?directory=..' })), 400, 'INVALID_QUERY');
});

test('验证理由、审核状态、未知字段、JSON与请求流限额', async t => {
  const { handle, id } = await fixture(t);
  for (const reason of ['', '  ', null, 1, 'x'.repeat(1001), '\u0000']) {
    await error(await handle(request(decision(id, 'approved', reason))), 400, 'INVALID_REASON');
  }
  await error(await handle(request(decision(id, 'pending'))), 400, 'INVALID_STATUS');
  await error(await handle(request({ ...decision(id), reviewedBy: 'forged' })), 400, 'INVALID_REVIEW');
  await error(await handle(request('[]')), 400, 'INVALID_REVIEW');
  await error(await handle(request('{')), 400, 'INVALID_JSON');
  await error(await handle(request(decision(id), { headers: { 'Content-Type': 'text/plain' } })), 415, 'JSON_REQUIRED');
  await error(await handle(request(' '.repeat(8193))), 413, 'BODY_TOO_LARGE');
  await error(await handle(request(decision(id), { headers: { 'Content-Length': '9000' } })), 413, 'BODY_TOO_LARGE');
});

test('GET/PATCH均鉴权，Cookie写请求校验Origin，Bearer保留CLI兼容', async t => {
  const { handle, id, directory } = await fixture(t);
  for (const body of [undefined, decision(id)]) {
    await error(await handle(request(body, { headers: { Cookie: '' } })), 401, 'UNAUTHORIZED');
  }
  for (const headers of [{ Origin: 'https://evil.test' }, { Origin: '' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    await error(await handle(request(decision(id), { headers })), 403, 'CROSS_ORIGIN_WRITE');
  }
  const response = await handle(request(decision(id), { headers: { Cookie: '', Origin: '', Authorization: `Bearer ${process.env.ADMIN_TOKEN}` } }));
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(await readFile(join(directory, `${id}.json`), 'utf8')).reviewedBy, 'admin');
  await error(await handle(request(undefined, { method: 'DELETE' })), 405, 'METHOD_NOT_ALLOWED');
});

test('不存在记录返回404，损坏记录失败关闭且不泄露路径', async t => {
  const { handle, directory, id } = await fixture(t);
  await error(await handle(request(decision('00000000-0000-4000-8000-000000000000'))), 404, 'SUBMISSION_NOT_FOUND');
  await writeFile(join(directory, `${id}.json`), '{broken');
  const response = await handle(request(decision(id)));
  const body = await error(response, 500, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(body).includes(directory));
  assert.equal(await readFile(join(directory, `${id}.json`), 'utf8'), '{broken');
});

test('枚举忽略非UUID文件、临时文件、目录，直接审核拒绝符号链接', async t => {
  const { directory, id } = await fixture(t);
  await writeFile(join(directory, 'secrets.json'), 'not json');
  await writeFile(join(directory, '.temporary.tmp'), 'not json');
  await mkdir(join(directory, '00000000-0000-4000-8000-000000000001.json'));
  assert.equal((await listSubmissions(new URLSearchParams(), directory)).total, 1);
  const linkId = '00000000-0000-4000-8000-000000000002';
  try { await symlink(join(directory, `${id}.json`), join(directory, `${linkId}.json`)); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('Windows 未授予符号链接权限，仅跳过链接断言'); return; } throw error; }
  await assert.rejects(reviewSubmission(decision(linkId), directory));
  assert.equal((await listSubmissions(new URLSearchParams(), directory)).total, 1);
});

test('审核使用精简查询表格，保留安全渲染、会话及过期跳转', async () => {
  const page = await readFile(new URL('../src/pages/admin/reviews.astro', import.meta.url), 'utf8');
  const script = await readFile(new URL('../src/scripts/admin-reviews.ts', import.meta.url), 'utf8');
  assert.match(page, /AdminLayout/); assert.match(page, /<tbody id="review-list"/); assert.doesNotMatch(page, /<h1|class="intro"|class="boundary"/);
  const docs = await readFile(new URL('../docs/管理员登录与审核说明.md', import.meta.url), 'utf8');
  assert.match(docs, /同一 MySQL 事务/);
  assert.match(script, /通过并发布/);
  assert.doesNotMatch(script, /未自动入库或发布/);
  const layout = await readFile(new URL('../src/layouts/AdminLayout.astro', import.meta.url), 'utf8');
  assert.match(layout, /\/admin\/menus\//); assert.match(page, /id="review-filters"/);
  assert.match(script, /textContent/); assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|localStorage|sessionStorage/);
  assert.match(script, /\/api\/admin\/session/); assert.match(script, /response.status === 401/);
  assert.match(script, /\/admin\/login\/\?next=%2Fadmin%2Freviews%2F/);
  assert.match(script, /method: 'DELETE'/); assert.match(script, /credentials: 'same-origin'/);
});




// 只约束页面结构和浏览器 API，不绑定实现中的函数名、变量名及属性顺序。
test('审批表格保留八列，详情和理由不再单独占列', async () => {
  const page = await readFile(new URL('../src/pages/admin/reviews.astro', import.meta.url), 'utf8');
  const table = page.match(/<table\b[^>]*>[\s\S]*?<\/table>/i)?.[0];
  assert.ok(table, '应保留提交记录表格');
  const head = table.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/i)?.[1];
  assert.ok(head, '表格应有表头');
  const headings = [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map(([, text]) => text.replace(/<[^>]*>/g, '').replace(/\s|\//g, ''));
  assert.deepEqual(headings, ['序号', '站点名称', '所属分类', '审核状态', '提交时间', '审核人', '审核时间', '操作']);
  assert.match(table, /<tbody\b[^>]*\bid\s*=\s*["']review-list["']/i);
  assert.doesNotMatch(table, /<(?:details|form|textarea)\b/i, '表格内不应保留行内详情或审核表单');
});

test('审批原生弹窗包含标题、详情、必填理由、错误提示与关闭入口', async () => {
  const page = await readFile(new URL('../src/pages/admin/reviews.astro', import.meta.url), 'utf8');
  const dialog = page.match(/<dialog\b[^>]*\bid\s*=\s*["']review-dialog["'][^>]*>[\s\S]*?<\/dialog>/i)?.[0];
  assert.ok(dialog, '应提供原生 dialog#review-dialog');
  assert.match(dialog, /<h[1-6]\b[^>]*\bid\s*=\s*["']review-dialog-title["']/i);
  assert.match(dialog, /<dl\b[^>]*\bid\s*=\s*["']review-dialog-fields["']/i);
  const form = dialog.match(/<form\b[^>]*\bid\s*=\s*["']review-form["'][^>]*>[\s\S]*?<\/form>/i)?.[0];
  assert.ok(form, '审核表单应位于弹窗内');
  const reason = form.match(/<textarea\b[^>]*\bid\s*=\s*["']review-reason["'][^>]*>/i)?.[0];
  assert.ok(reason, '审核理由应位于审核表单内');
  assert.match(reason, /\srequired(?=\s|=|\/?>)/i, '理由必须必填');
  assert.match(reason, /\smaxlength\s*=\s*(?:"1000"|'1000'|1000(?=\s|\/?>))/i);
  assert.match(dialog, /<[a-z][\w-]*\b[^>]*\bid\s*=\s*["']review-dialog-message["']/i);
  assert.match(dialog, /<button\b[^>]*\bdata-review-close(?=\s|=|\/?>)/i);
});

test('审批弹窗脚本保留详情与审核入口、安全渲染和PATCH提交', async () => {
  const script = await readFile(new URL('../src/scripts/admin-reviews.ts', import.meta.url), 'utf8');
  for (const id of ['review-dialog', 'review-dialog-title', 'review-dialog-fields', 'review-form', 'review-reason', 'review-dialog-message']) {
    assert.match(script, new RegExp(`["']#?${id}["']`), `脚本应绑定 ${id}`);
  }
  assert.match(script, /\[data-review-close\]/, '脚本应绑定弹窗关闭入口');
  assert.match(script, /\.showModal\s*\(/, '使用原生模态打开 API');
  assert.match(script, /\.close\s*\(/, '使用原生关闭 API');
  assert.match(script, /["'][^"'\r\n]*详情[^"'\r\n]*["']/, '保留详情入口');
  assert.match(script, /["'][^"'\r\n]*审核[^"'\r\n]*["']/, '保留审核入口');
  assert.match(script, /\.textContent\s*=/);
  assert.doesNotMatch(script, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/, '不得使用 HTML 注入渲染记录');
  assert.doesNotMatch(script, /createElement\s*\(\s*["'](?:details|summary|textarea|form)["']\s*\)/, '不再逐行创建详情或审核表单');
  assert.match(script, /addEventListener\s*\(\s*["']submit["']/);
  assert.match(script, /["']\/api\/admin\/submissions["']/);
  assert.match(script, /method\s*:\s*["']PATCH["']/);
  assert.match(script, /["']Content-Type["']\s*:\s*["']application\/json["']/);
  const payload = script.match(/JSON\.stringify\s*\(\s*\{([^}]*)\}/s)?.[1];
  assert.ok(payload, '审核请求应序列化 JSON 对象');
  for (const key of ['id', 'status', 'reason']) {
    assert.match(payload, new RegExp(`(?:^|,)\\s*${key}\\s*(?=:|,|$)`), `审核请求保留 ${key} 字段，允许简写及任意顺序`);
  }
});
test('正式审核在seed模式下拒绝发布，不连接或写入数据库', async () => {
  const previous = process.env.NAV_STORAGE;
  process.env.NAV_STORAGE = 'seed';
  try {
    await assert.rejects(reviewSubmission({ id: '12345678-1234-4123-8123-123456789abc', status: 'approved', reason: '测试' }),
      error => error.status === 503 && error.code === 'PUBLISH_STORAGE_READ_ONLY');
  } finally {
    if (previous === undefined) delete process.env.NAV_STORAGE;
    else process.env.NAV_STORAGE = previous;
  }
});


test('名称搜索先筛选后分页，trim、大小写、状态与总数一致', async t => {
  const { directory, handle } = await fixture(t);
  const names = ['Alpha 第一站', '无关站点', '第二站 aLPHa', 'ALPHA 已通过', '仅备注匹配'];
  const ids = [];
  for (const [index, name] of names.entries()) {
    const saved = await saveSubmission({ ...valid, name, remark: 'Alpha' }, directory);
    const path = join(directory, saved.id + '.json');
    const record = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...record, createdAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      status: index === 3 ? 'approved' : 'pending' }));
    ids.push(saved.id);
  }
  for (const [page, expected] of [[1, [ids[2]]], [2, [ids[0]]], [3, []]]) {
    const query = '?' + new URLSearchParams({ q: '  ALpHa  ', page: String(page), pageSize: '1' });
    const response = await handle(request(undefined, { query }));
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.deepEqual(data.items.map(item => item.id), expected);
    assert.equal(data.total, 2); assert.equal(data.totalPages, 2);
    assert.equal(data.page, page); assert.equal(data.pageSize, 1);
  }
  const approved = await listSubmissions(new URLSearchParams('q=alpha&status=approved'), directory);
  assert.deepEqual(approved.items.map(item => item.id), [ids[3]]);
  assert.equal(approved.total, 1);
  const missing = await listSubmissions(new URLSearchParams('q=不存在'), directory);
  assert.deepEqual(missing.items, []); assert.equal(missing.total, 0); assert.equal(missing.totalPages, 0);
  const original = await listSubmissions(new URLSearchParams(), directory);
  for (const q of ['', '   ']) {
    assert.deepEqual(await listSubmissions(new URLSearchParams({ q }), directory), original);
  }
});

test('名称搜索将百分号下划线作为普通字符，支持中文与100字边界', async t => {
  const { directory } = await fixture(t);
  for (const name of ['完成100%工具', 'my_tool', 'myXtool', '中文导航', 'x'.repeat(100)]) {
    await saveSubmission({ ...valid, name }, directory);
  }
  for (const [q, expected] of [['%', '完成100%工具'], ['_', 'my_tool'], ['中文', '中文导航'], ['  ' + 'x'.repeat(100) + '  ', 'x'.repeat(100)]]) {
    const result = await listSubmissions(new URLSearchParams({ q }), directory);
    assert.deepEqual(result.items.map(item => item.name), [expected]); assert.equal(result.total, 1);
  }
});

test('拒绝超长和重复搜索参数，非法参数在访问存储前失败', async t => {
  const { handle } = await fixture(t);
  for (const query of ['?' + new URLSearchParams({ q: 'x'.repeat(101) }), '?q=alpha&q=beta', '?q=&q=']) {
    await error(await handle(request(undefined, { query })), 400, 'INVALID_QUERY');
    await assert.rejects(listSubmissions(new URLSearchParams(query)), e => e.status === 400 && e.code === 'INVALID_QUERY');
  }
});
