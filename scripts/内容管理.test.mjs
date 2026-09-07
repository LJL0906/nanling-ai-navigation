import test from 'node:test';
import assert from 'node:assert/strict';
import { contentRevision, normalizedContentUrl, contentUrlKey, validateContentCommand, readContentRequest } from '../src/server/content-validation.ts';
import { createContentStore } from '../src/server/content-store.ts';
import { createContentHandler } from '../src/server/content-handler.ts';
import { loginAdmin, logoutAdmin } from '../src/server/admin-session.ts';

const category = (extra = {}) => ({ name: '工具', slug: 'tools', color: '#aAbB01', icon: 'lucide:folder', order: 7, ...extra });
const site = (extra = {}) => ({ name: '示例', slug: 'example', url: 'https://example.com/', category: 'c1', description: '', tags: ['工具'], sortOrder: 8, ...extra });
const catRow = (id, extra = {}) => ({ id, slug: id === 'c1' ? 'tools' : 'other', sort_order: 7, payload: category({ slug: id === 'c1' ? 'tools' : 'other', name: id }), ...extra });
const siteRow = (id, extra = {}) => ({ id, slug: id, category_id: 'c1', sort_order: 8, payload: site({ slug: id, url: `https://${id}.example/`, aliases: ['别名'], alternateUrls: ['https://alternate.example/'], verification: { status: 'verified', checkedAt: '2026-09-01' } }), ...extra });
const revision = (row, kind) => contentRevision({ ...row.payload, id: row.id, slug: row.slug, ...(kind === 'sites' ? { category: row.category_id, sortOrder: row.sort_order } : { order: row.sort_order }) });
const command = (kind, method = 'POST', row, item) => validateContentCommand(method, { kind, ...(method === 'POST' ? {} : { id: row.id, revision: revision(row, kind) }), ...(method === 'DELETE' ? {} : { item: item ?? (kind === 'sites' ? site() : category()) }) });
const errorIs = (code, status) => error => { assert.equal(error.code, code); assert.equal(error.status, status); return true; };

// 只识别当前契约的查询，不实现 SQL 引擎；未知 SQL 立即令测试失败。
function fixture(options = {}) {
  const events = [], writes = [], unexpected = [];
  const categories = options.categories ?? [catRow('c1'), catRow('c2')];
  const sites = options.sites ?? [siteRow('s1'), siteRow('s2')];
  const c = {
    async query(sql, args = []) {
      if (sql === 'SELECT GET_LOCK(?, 10) AS acquired') {
        events.push(`lock:${args[0]}`);
        return [[{ acquired: options.busy === args[0] ? 0 : 1 }]];
      }
      if (sql === 'SELECT RELEASE_LOCK(?) AS released') {
        events.push(`unlock:${args[0]}`);
        if (options.releaseError) throw new Error('release failed');
        return [[{ released: options.badRelease ? 0 : 1 }]];
      }
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') { events.push('isolation'); return [[]]; }
      if (/^SELECT \* FROM nav_(categories|sites) ORDER BY sort_order, id(?: FOR UPDATE)?$/.test(sql)) {
        events.push(sql);
        return [sql.includes('nav_categories') ? categories : sites];
      }
      if (sql === 'SELECT href, payload FROM nav_menus FOR UPDATE') return [options.menus ?? []];
      if (sql === "SELECT payload FROM nav_submissions WHERE status = 'pending' FOR UPDATE") return [options.submissions ?? []];
      if (sql.replace(/\s+/g, ' ').trim() === "INSERT INTO nav_notifications (id, event_key, kind, visibility, recipient_user_id, title, body, status, site_id, created_at) VALUES (?, ?, 'site', 'public', NULL, ?, ?, ?, ?, UTC_TIMESTAMP(3))") {
        events.push('notification');
        assert.equal(args[1], `site:${args[4]}:${args[5]}`);
        if (options.notificationError) throw new Error('notification failed');
        return [{ affectedRows: 1 }];
      }
      unexpected.push(sql); throw new Error(`Unexpected SQL: ${sql}`);
    },
    async execute(sql, args) { events.push('execute'); writes.push({ sql, args }); if (options.executeError) throw options.executeError; return [{ affectedRows: 1 }]; },
    async beginTransaction() { events.push('begin'); },
    async commit() { events.push('commit'); if (options.commitError) throw new Error('commit failed'); },
    async rollback() { events.push('rollback'); if (options.rollbackError) throw new Error('rollback failed'); },
    release() { events.push('release'); },
    destroy() { events.push('destroy'); },
  };
  const store = createContentStore({ driver: () => options.driver ?? 'mysql', getPool: () => ({ async getConnection() { events.push('connection'); return c; } }), invalidate: () => events.push('invalidate') });
  return { store, events, writes, categories, sites, unexpected };
}
function cleanup(f, kind, success = true, discard = false) {
  assert.deepEqual(f.unexpected, []);
  assert.deepEqual(f.events.filter(e => e.startsWith('lock:')), ['lock:nav-submissions:publish', ...(kind === 'categories' ? ['lock:nanling_menu_initial_import'] : [])]);
  assert.deepEqual(f.events.filter(e => e.startsWith('unlock:')), [...(kind === 'categories' ? ['unlock:nanling_menu_initial_import'] : []), 'unlock:nav-submissions:publish']);
  assert.equal(f.events.filter(e => e === 'invalidate').length, success ? 1 : 0);
  assert.equal(f.events.includes(discard ? 'release' : 'destroy'), false);
  assert.equal(f.events.at(success ? -2 : -1), discard ? 'destroy' : 'release');
  if (success) { assert.ok(f.events.indexOf('commit') < f.events.indexOf('unlock:nav-submissions:publish')); assert.equal(f.events.includes('rollback'), false); }
}

test('严格字段：拒绝未知、缺失、错误类型以及非法 id/revision', () => {
  for (const kind of ['sites', 'categories']) {
    const valid = { kind, item: kind === 'sites' ? site() : category() };
    for (const body of [null, [], { ...valid, extra: true }, { kind }, { ...valid, item: [] }, { ...valid, item: { ...valid.item, extra: true } }]) {
      assert.throws(() => validateContentCommand('POST', body), errorIs('INVALID_CONTENT', 400));
    }
    for (const key of Object.keys(valid.item)) {
      const body = structuredClone(valid); delete body.item[key];
      assert.throws(() => validateContentCommand('POST', body), errorIs('INVALID_CONTENT', 400));
    }
    for (const patch of [{ id: '../bad' }, { id: '' }, { revision: 'a'.repeat(63) }, { revision: 'A'.repeat(64) }, { item: {} }]) {
      assert.throws(() => validateContentCommand('DELETE', { kind, id: 'valid-id', revision: 'a'.repeat(64), ...patch }), errorIs('INVALID_CONTENT', 400));
    }
  }
  assert.throws(() => validateContentCommand('PUT', {}), errorIs('INVALID_CONTENT', 400));
  assert.throws(() => validateContentCommand('POST', { kind: 'menus', item: category() }), errorIs('INVALID_CONTENT', 400));
});

test('URL 协议、凭证、空白、反斜杠及去重规范化', () => {
  for (const url of ['javascript:alert(1)', 'ftp://example.com', '//example.com', 'https://u:p@example.com', 'https://example.com/a b', 'https://example.com\\evil', 'https://', 42]) {
    assert.throws(() => normalizedContentUrl(url), errorIs('INVALID_CONTENT', 400));
  }
  assert.equal(normalizedContentUrl(' HTTPS://EXAMPLE.COM:443/a '), 'https://example.com/a');
  assert.equal(contentUrlKey('https://example.com/a///#part'), contentUrlKey('https://example.com/a'));
  assert.notEqual(contentUrlKey('https://example.com/?a=1'), contentUrlKey('https://example.com/?a=2'));
});

test('slug/icon/颜色/排序/标签严格校验并规范化', () => {
  for (const kind of ['categories', 'sites']) {
    const base = kind === 'sites' ? site() : category();
    const order = kind === 'sites' ? 'sortOrder' : 'order';
    for (const extra of [{ slug: 'Bad' }, { slug: '-bad' }, { slug: 'a--b' }, { slug: 'a/b' }, { name: 'a\u0000b' }, ...[-1, 1000001, 0.5, '8', null, NaN, Infinity].map(value => ({ [order]: value }))]) {
      assert.throws(() => validateContentCommand('POST', { kind, item: { ...base, ...extra } }), errorIs('INVALID_CONTENT', 400));
    }
    for (const value of [0, 1000000]) assert.equal(command(kind, 'POST', null, { ...base, [order]: value }).item[order], value);
  }
  for (const extra of [{ slug: 'admin' }, { slug: 'api' }, { icon: 'lucide:not-a-real-icon' }, { icon: 'simple-icons:github' }, { color: '#fff' }]) {
    assert.throws(() => command('categories', 'POST', null, category(extra)), errorIs('INVALID_CONTENT', 400));
  }
  for (const extra of [{ category: '../x' }, { tags: 'tag' }, { tags: [42] }, { tags: Array(31).fill('tag') }, { description: 'x'.repeat(2001) }]) {
    assert.throws(() => command('sites', 'POST', null, site(extra)), errorIs('INVALID_CONTENT', 400));
  }
  assert.deepEqual(command('sites', 'POST', null, site({ name: ' 示例 ', tags: [' 工具 ', '工具'] })).item.tags, ['工具']);
});

test('revision 对对象键顺序稳定，对数组顺序和真实值变化敏感', () => {
  const a = { x: [{ a: 1, b: 2 }], z: { c: 3, d: 4 } };
  assert.equal(contentRevision(a), contentRevision({ z: { d: 4, c: 3 }, x: [{ b: 2, a: 1 }] }));
  assert.match(contentRevision(a), /^[a-f0-9]{64}$/);
  assert.notEqual(contentRevision([1, 2]), contentRevision([2, 1]));
  assert.notEqual(contentRevision(a), contentRevision({ ...a, extra: true }));
});

test('JSON 入口检查 MIME、语法与真实字节上限（不信任 Content-Length）', async () => {
  const request = (body, headers = {}) => new Request('https://nav.example/api/content', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  await assert.rejects(readContentRequest(request('{}', { 'content-type': 'text/plain' })), errorIs('JSON_REQUIRED', 415));
  await assert.rejects(readContentRequest(request('{')), errorIs('INVALID_CONTENT', 400));
  await assert.rejects(readContentRequest(request(JSON.stringify('中'.repeat(6000)), { 'content-length': '1' })), errorIs('CONTENT_TOO_LARGE', 413));
  assert.deepEqual(await readContentRequest(request('{"kind":"sites"}')), { kind: 'sites' });
});

for (const kind of ['sites', 'categories']) {
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    test(`${kind} ${method} 使用参数化 SQL，提交后失效缓存并逆序释放锁`, async () => {
      const f = fixture(); const row = kind === 'sites' ? f.sites[0] : f.categories[1];
      const input = kind === 'sites' ? site({ slug: method === 'PATCH' ? row.slug : 'example', name: "O'Reilly", category: 'c2' }) : category({ slug: method === 'PATCH' ? row.slug : 'new-category', name: "O'Reilly" });
      const result = await f.store.write(method, command(kind, method, row, input));
      const table = kind === 'sites' ? 'nav_sites' : 'nav_categories';
      assert.equal(f.writes.length, kind === 'sites' && method === 'DELETE' ? 2 : 1);
      if (kind === 'sites' && method === 'DELETE') assert.deepEqual(f.writes[0], { sql: 'DELETE FROM nav_user_records WHERE site_id = ?', args: [row.id] });
      assert.equal(f.events.filter(e => e === 'notification').length, kind === 'sites' && method !== 'PATCH' ? 1 : 0);
      const { sql, args } = f.writes.at(-1);
      if (method === 'DELETE') { assert.equal(sql, `DELETE FROM ${table} WHERE id = ?`); assert.deepEqual(args, [row.id]); }
      else {
        const expected = kind === 'sites'
          ? (method === 'POST' ? 'INSERT INTO nav_sites (id, category_id, slug, sort_order, payload) VALUES (?, ?, ?, ?, ?)' : 'UPDATE nav_sites SET category_id = ?, sort_order = ?, payload = ? WHERE id = ?')
          : (method === 'POST' ? 'INSERT INTO nav_categories (id, slug, sort_order, payload) VALUES (?, ?, ?, ?)' : 'UPDATE nav_categories SET sort_order = ?, payload = ? WHERE id = ?');
        assert.equal(sql, expected);
        const value = JSON.parse(args[method === 'POST' ? args.length - 1 : args.length - 2]);
        assert.equal(value.id, result.id); assert.equal(value.name, input.name); assert.equal(value.slug, input.slug);
        if (kind === 'sites') {
          assert.deepEqual(args.slice(0, method === 'POST' ? 4 : 2), method === 'POST' ? [result.id, 'c2', input.slug, 8] : ['c2', 8]);
          assert.equal(value.domain, 'example.com'); if (method === 'POST') assert.equal(Object.hasOwn(value, 'sortOrder'), false);
          assert.deepEqual(value.verification, { status: 'unverified', checkedAt: null });
          assert.deepEqual(value.aliases, method === 'PATCH' ? ['别名'] : []);
        } else {
          assert.deepEqual(args.slice(0, method === 'POST' ? 3 : 1), method === 'POST' ? [result.id, input.slug, 7] : [7]);
          assert.equal(value.count, 0);
        }
        if (method === 'PATCH') assert.equal(args.at(-1), row.id);
      }
      assert.equal(method === 'POST' ? result.id.startsWith(kind === 'sites' ? 'site-' : 'category-') : result.id === row.id, true);
      assert.ok(f.events.includes('SELECT * FROM nav_categories ORDER BY sort_order, id FOR UPDATE'));
      assert.ok(f.events.includes('SELECT * FROM nav_sites ORDER BY sort_order, id FOR UPDATE'));
      assert.ok(f.events.indexOf('begin') < f.events.indexOf('execute'));
      cleanup(f, kind);
    });
  }
}

test('列表以 SQL 列为准、解析 JSON payload；分类动态 count 不改变 revision', async () => {
  const f = fixture(); const row = f.categories[0];
  const first = await f.store.list('categories');
  assert.equal(first.writable, true); assert.equal(first.items[0].count, 2);
  f.sites.pop(); row.payload = JSON.stringify(row.payload);
  const second = await f.store.list('categories');
  assert.equal(second.items[0].count, 1); assert.equal(first.items[0].revision, second.items[0].revision);
  assert.equal(f.events.includes('invalidate'), false);
  const s = fixture({ sites: [siteRow('s1', { sort_order: 99, category_id: 'c2' })] });
  const listed = (await s.store.list('sites')).items[0];
  assert.equal(listed.sortOrder, 99); assert.equal(listed.category, 'c2');
});

for (const [label, options, code] of [
  ['站点引用', {}, 'CATEGORY_IN_USE'],
  ['首页菜单锚点', { menus: [{ href: '/other/', payload: { homeAnchor: 'tools' } }] }, 'CATEGORY_MENU_REFERENCE'],
  ['菜单分类路径', { menus: [{ href: '/', payload: JSON.stringify({ categoryPath: '/tools/' }) }] }, 'CATEGORY_MENU_REFERENCE'],
  ['菜单 href 锚点', { menus: [{ href: '/#tools', payload: {} }] }, 'CATEGORY_MENU_REFERENCE'],
  ['菜单 href 子路径', { menus: [{ href: '/tools/page/2/', payload: {} }] }, 'CATEGORY_MENU_REFERENCE'],
  ['待审核引用', { submissions: [{ payload: JSON.stringify({ categoryId: 'c1' }) }] }, 'CATEGORY_PENDING_REVIEW'],
]) {
  test(`删除分类阻止${label}，rollback 且不失效缓存`, async () => {
    const f = fixture({ ...(label === '站点引用' ? {} : { sites: [siteRow('s1', { category_id: 'c2' })] }), ...options });
    await assert.rejects(f.store.write('DELETE', command('categories', 'DELETE', f.categories[0])), errorIs(code, 409));
    assert.equal(f.writes.length, 0); assert.ok(f.events.includes('rollback')); assert.equal(f.events.includes('commit'), false);
    cleanup(f, 'categories', false);
  });
}

for (const kind of ['sites', 'categories']) {
  test(`${kind} 版本冲突、缺失记录、最后一条、slug 不可变`, async () => {
    for (const scenario of ['revision', 'missing', 'last', 'slug']) {
      const f = fixture(scenario === 'last' ? { categories: [catRow('c1')], sites: [siteRow('s1')] } : {});
      const row = kind === 'sites' ? f.sites[0] : f.categories[0];
      const method = scenario === 'slug' ? 'PATCH' : 'DELETE';
      const cmd = command(kind, method, row, kind === 'sites' ? site({ slug: 'changed' }) : category({ slug: 'changed' }));
      if (scenario === 'revision') cmd.revision = '0'.repeat(64);
      if (scenario === 'missing') cmd.id = 'missing';
      const code = { revision: 'CONTENT_CONFLICT', missing: 'CONTENT_NOT_FOUND', last: 'CONTENT_LAST_RECORD', slug: 'CONTENT_SLUG_IMMUTABLE' }[scenario];
      await assert.rejects(f.store.write(method, cmd), errorIs(code, scenario === 'missing' ? 404 : 409));
      assert.equal(f.writes.length, 0); assert.ok(f.events.includes('rollback')); cleanup(f, kind, false);
    }
  });
}

test('重复分类、主/备用 URL、分类内 slug 和不存在的分类阻止写入', async () => {
  for (const [kind, input, code] of [
    ['categories', category({ slug: 'new', name: 'C1' }), 'CATEGORY_DUPLICATE'],
    ['categories', category(), 'CATEGORY_DUPLICATE'],
    ['sites', site({ url: 'https://s1.example/#x' }), 'SITE_URL_DUPLICATE'],
    ['sites', site({ url: 'https://alternate.example/#x' }), 'SITE_URL_DUPLICATE'],
    ['sites', site({ slug: 's1' }), 'SITE_SLUG_DUPLICATE'],
    ['sites', site({ category: 'absent' }), 'CATEGORY_NOT_FOUND'],
  ]) {
    const f = fixture();
    await assert.rejects(f.store.write('POST', command(kind, 'POST', null, input)), errorIs(code, 409));
    assert.equal(f.writes.length, 0); cleanup(f, kind, false);
  }
});

for (const [label, options, code, discard] of [
  ['SQL 唯一键', { executeError: { code: 'ER_DUP_ENTRY' } }, 'CONTENT_CONFLICT', false],
  ['SQL 外键', { executeError: { code: 'ER_ROW_IS_REFERENCED_2' } }, 'CONTENT_CONFLICT', false],
  ['SQL 死锁', { executeError: { code: 'ER_LOCK_DEADLOCK' } }, 'CONTENT_CONFLICT', false],
  ['普通数据库异常', { executeError: new Error('secret database address') }, 'CONTENT_UNAVAILABLE', false],
  ['通知写入失败', { notificationError: true }, 'CONTENT_UNAVAILABLE', false],
  ['commit 失败', { commitError: true }, 'CONTENT_UNAVAILABLE', false],
  ['rollback 失败', { executeError: new Error('failed'), rollbackError: true }, 'CONTENT_UNAVAILABLE', true],
]) {
  test(`${label}：回滚、释放发布锁、不失效缓存`, async () => {
    const f = fixture(options);
    await assert.rejects(f.store.write('POST', command('sites')), errorIs(code, code === 'CONTENT_CONFLICT' ? 409 : 503));
    assert.ok(f.events.includes('rollback')); cleanup(f, 'sites', false, discard);
  });
}

for (const options of [{ badRelease: true }, { releaseError: true }]) {
  test(`提交后释放锁${options.badRelease ? '返回异常' : '抛错'}，销毁连接且仍失效缓存`, async () => {
    const f = fixture(options); await f.store.write('POST', command('sites')); cleanup(f, 'sites', true, true);
  });
}

test('第二把锁繁忙时也释放已持有的发布锁，不启动事务', async () => {
  const f = fixture({ busy: 'nanling_menu_initial_import' });
  await assert.rejects(f.store.write('POST', command('categories')), errorIs('CONTENT_BUSY', 409));
  assert.equal(f.events.includes('begin'), false); assert.equal(f.events.includes('rollback'), false);
  cleanup(f, 'categories', false);
});

test('种子列表只读，所有写方法在获取连接前拒绝', async () => {
  const f = fixture({ driver: 'seed' });
  for (const kind of ['sites', 'categories']) {
    const result = await f.store.list(kind); assert.equal(result.writable, false); assert.ok(result.items.length > 0);
    for (const method of ['POST', 'PATCH', 'DELETE']) await assert.rejects(f.store.write(method, { kind }), errorIs('CONTENT_READ_ONLY', 503));
  }
  assert.deepEqual(f.events, []);
});

test('handler 真鉴权：未登录、跨站 Cookie、同源写入、Bearer、只读与查询边界', async t => {
  const env = { ADMIN_TOKEN: 'test-token-'.repeat(5), ADMIN_USERNAME: 'content-test-admin', ADMIN_PASSWORD: 'content-test-password' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const origin = 'https://nav.example';
  const req = (method, headers = {}, body = { kind: 'sites', item: site() }, query = '') => new Request(`${origin}/api/admin/content${query}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: JSON.stringify(body) }) });
  const f = fixture(); const handler = createContentHandler(f.store);
  const check = async (request, status, code) => { const response = await handler(request); assert.equal(response.status, status); assert.equal((await response.json()).error.code, code); };
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) await check(req(method), 401, 'UNAUTHORIZED');
  const session = await loginAdmin(new Request(`${origin}/admin/login`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD }) }));
  const cookie = session.cookie.split(';')[0];
  t.after(() => logoutAdmin(new Request(`${origin}/logout`, { headers: { origin, cookie } })));
  for (const method of ['POST', 'PATCH', 'DELETE']) {
    for (const headers of [{ cookie }, { cookie, origin: 'https://evil.example' }, { cookie, origin, 'sec-fetch-site': 'cross-site' }]) await check(req(method, headers), 403, 'CROSS_ORIGIN_WRITE');
  }
  assert.deepEqual(f.events, []);
  assert.equal((await handler(req('POST', { cookie, origin }))).status, 200);
  const bearer = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
  assert.equal((await handler(req('GET', bearer, null, '?kind=sites'))).status, 200);
  for (const query of ['', '?kind=sites&kind=sites', '?kind=sites&extra=1']) await check(req('GET', bearer, null, query), 400, 'INVALID_QUERY');
  await check(req('POST', bearer, undefined, '?kind=sites'), 400, 'INVALID_QUERY');
  await check(req('POST', bearer, { kind: 'sites', item: { ...site(), extra: true } }), 400, 'INVALID_CONTENT');
  const unsupported = await handler(req('PUT', bearer)); assert.equal(unsupported.status, 405); assert.equal(unsupported.headers.get('allow'), 'GET, POST, PATCH, DELETE');
  const readonly = await createContentHandler(fixture({ driver: 'seed' }).store)(req('POST', bearer));
  assert.equal(readonly.status, 503); assert.equal((await readonly.json()).error.code, 'CONTENT_READ_ONLY');
});

