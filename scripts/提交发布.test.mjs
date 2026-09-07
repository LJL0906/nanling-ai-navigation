import test from 'node:test';
import assert from 'node:assert/strict';
import { publishSubmission } from '../src/server/submission-publish.ts';
import { decodeNavigationRows } from '../src/server/mysql-reader.ts';

const id = '12345678-1234-4123-8123-123456789abc';
const otherId = '22345678-1234-4123-8123-123456789abc';
const record = { id, name: '测试站点', url: 'https://EXAMPLE.test:443/tools/', categoryId: 'ai',
  customCategory: '', remark: '审核私有备注，不得公开', iconUrl: 'https://icons.test/icon.png',
  iconObject: { provider: 'oss', key: 'private-key' } };
function category(name = 'AI', categoryId = 'ai', order = 7) {
  return { id: categoryId, slug: categoryId, sort_order: order,
    payload: { id: categoryId, slug: categoryId, name, color: '#3777f5', icon: 'lucide:folder', order, count: 0 } };
}
function database(categories = [category()], sites = []) {
  return { categories: structuredClone(categories), sites: structuredClone(sites), tail: Promise.resolve() };
}
function connection(db = database()) {
  let unlock;
  const calls = [];
  const api = {
    calls, db,
    async query(sql, values) {
      assert.ok(unlock, '通知必须位于调用方发布锁内');
      assert.match(sql, /^INSERT INTO nav_notifications/);
      assert.ok(sql.includes("'site', 'public'"));
      assert.ok(!JSON.stringify(values).includes('private-key'));
      calls.push({ sql, values });
      return [{ affectedRows: 1 }];
    },
    // 模拟仓储在调用 helper 前取得命名锁，并在事务结束后释放。
    async acquire() {
      assert.equal(unlock, undefined, '每个 fake 连接模拟一次事务');
      const previous = db.tail;
      let release;
      db.tail = new Promise(resolve => { release = resolve; });
      await previous;
      unlock = release;
    },
    finish() { unlock?.(); unlock = undefined; },
    async execute(sql, values = []) {
      calls.push({ sql, values });
      assert.ok(!/nav_settings|GET_LOCK|RELEASE_LOCK/.test(sql), 'helper 不操作配置表或命名锁');
      assert.ok(unlock, '调用方必须先持有命名锁');
      if (sql.startsWith('SELECT ')) {
        assert.match(sql, /ORDER BY id FOR UPDATE$/);
        if (sql.includes('FROM nav_categories ')) return [structuredClone(db.categories)];
        if (sql.includes('FROM nav_sites ')) return [structuredClone(db.sites)];
      }
      if (sql.startsWith('INSERT INTO nav_categories ')) {
        const [id, slug, sort_order, json] = values;
        assert.ok(!db.categories.some(row => row.id === id || row.slug === slug));
        db.categories.push({ id, slug, sort_order, payload: JSON.parse(json) });
        return [{ affectedRows: 1 }];
      }
      if (sql.startsWith('INSERT INTO nav_sites ')) {
        const [id, category_id, slug, sort_order, json] = values;
        assert.ok(!db.sites.some(row => row.id === id));
        db.sites.push({ id, category_id, slug, sort_order, payload: JSON.parse(json) });
        return [{ affectedRows: 1 }];
      }
      assert.fail(`未预期 SQL: ${sql}`);
    },
    commit() { assert.fail('helper 不得提交事务'); },
    rollback() { assert.fail('helper 不得回滚事务'); },
    release() { assert.fail('helper 不得释放连接'); },
    beginTransaction() { assert.fail('helper 不得开启事务'); },
  };
  return api;
}
async function run(db, value = record) {
  const conn = connection(db);
  await conn.acquire();
  try { return await publishSubmission(conn, value); }
  finally { conn.finish(); }
}
const status = value => error => error.status === value;

test('已有分类：稳定编号、合法 payload、来源图标保留但审核字段不公开', async () => {
  const conn = connection();
  try {
    await conn.acquire();
    assert.equal(await publishSubmission(conn, record), `submitted-${id}`);
    assert.equal(conn.db.categories.length, 1);
    const [site] = decodeNavigationRows(conn.db.categories, conn.db.sites).sites;
    assert.equal(site.id.length, 46);
    assert.equal(site.slug, site.id);
    assert.equal(site.category, 'ai');
    assert.equal(site.domain, 'example.test');
    assert.equal(site.url, 'https://example.test/tools/');
    assert.deepEqual(site.tags, []);
    assert.deepEqual(site.aliases, []);
    assert.deepEqual(site.alternateUrls, []);
    assert.deepEqual(site.sourceCategories, ['AI']);
    assert.deepEqual(site.verification, { status: 'unverified', checkedAt: null });
    assert.deepEqual(site.icon, { type: 'url', value: record.iconUrl });
    assert.deepEqual(site.sources, [{ dataset: 'submission', recordId: id, category: 'AI',
      subcategory: null, detailUrl: null, originalUrl: record.url }]);
    assert.ok(!JSON.stringify(site).includes(record.remark));
    assert.ok(!JSON.stringify(site).includes('private-key'));
    assert.match(conn.calls[0].sql, /^SELECT .* FROM nav_categories /);
  } finally { conn.finish(); }
});

test('不存在的 categoryId 拒绝，不能偷偷改为创建分类', async () => {
  const db = database();
  await assert.rejects(run(db, { ...record, categoryId: 'missing' }), status(400));
  assert.equal(db.sites.length, 0);
  assert.equal(db.categories.length, 1);
});

test('自定义分类只复用精确同名（支持 JSON 字符串 payload）', async () => {
  const db = database();
  db.categories[0].payload = JSON.stringify(db.categories[0].payload);
  await run(db, { ...record, categoryId: '', customCategory: 'AI' });
  assert.equal(db.categories.length, 1);
  assert.equal(db.sites[0].category_id, 'ai');
});

for (const name of ['ai', 'ＡＩ', "设计'; DROP TABLE nav_sites; --"]) {
  test(`不模糊合并拼写，缺失自定义分类参数化创建：${name}`, async () => {
    const db = database([category(), category('其他', 'other', 12)]);
    await run(db, { ...record, categoryId: '', customCategory: name });
    const created = db.categories.at(-1);
    assert.deepEqual(created.payload, { id: `submitted-${id}`, slug: `submitted-${id}`, name,
      color: '#3777f5', icon: 'lucide:folder', order: 13, count: 0 });
    assert.equal(created.sort_order, 13);
    assert.equal(decodeNavigationRows(db.categories, db.sites).categories.at(-1).count, 1);
  });
}

test('空分类表可创建首分类，无图标不从私有 iconObject 推导 URL', async () => {
  const db = database([]);
  await run(db, { ...record, categoryId: '', customCategory: '首分类', iconUrl: '' });
  assert.equal(db.categories[0].sort_order, 0);
  assert.equal(db.sites[0].payload.icon, null);
  decodeNavigationRows(db.categories, db.sites);
});

for (const url of ['https://example.test/tools', 'https://EXAMPLE.test:443/tools//#fragment']) {
  test(`同 URL 不同提交返回 409，且不创建无用分类：${url}`, async () => {
    const db = database();
    await run(db);
    await assert.rejects(run(db, { ...record, id: otherId, url, categoryId: '', customCategory: '不应创建' }), status(409));
    assert.equal(db.sites.length, 1);
    assert.equal(db.categories.length, 1);
  });
}

test('同 source id 重试幂等；变更 URL 冲突；保留路径大小写语义', async () => {
  const db = database();
  const result = await run(db);
  assert.equal(await run(db, { ...record, url: 'https://example.test/tools' }), result);
  assert.equal(db.sites.length, 1);
  await assert.rejects(run(db, { ...record, url: 'https://other.test/' }), status(409));
  await run(db, { ...record, id: otherId, url: 'https://example.test/Tools' });
  assert.equal(db.sites.length, 2);
});

test('稳定编号被其他来源占用时不得当作幂等', async () => {
  const db = database();
  await run(db);
  db.sites[0].payload.sources = [{ dataset: 'import', recordId: id }];
  await assert.rejects(run(db), status(409));
});

for (const patch of [{ id: 'invalid' }, { name: '' }, { url: 'javascript:alert(1)' },
  { url: 'https://user:password@example.test/' }, { categoryId: '' }, { customCategory: '冲突' },
  { iconUrl: 'data:image/png;base64,x' }]) {
  test(`非法输入在 SQL 前拒绝：${JSON.stringify(patch)}`, async () => {
    const conn = connection();
    await assert.rejects(publishSubmission(conn, { ...record, ...patch }), status(400));
    assert.equal(conn.calls.length, 0);
  });
}

test('并发同名分类等待调用方结束事务后复用（空表也有效）', async () => {
  const db = database([]);
  const first = connection(db);
  const second = connection(db);
  try {
    await first.acquire();
    await publishSubmission(first, { ...record, categoryId: '', customCategory: '并发分类' });
    let done = false;
    const pending = second.acquire().then(() => publishSubmission(second, { ...record, id: otherId, url: 'https://second.test',
      categoryId: '', customCategory: '并发分类' })).then(value => { done = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, false, '调用方结束事务并释放命名锁前不能继续发布');
    assert.equal(second.calls.length, 0);
    first.finish();
    await pending;
    assert.equal(db.categories.length, 1);
    assert.equal(db.sites.length, 2);
    assert.equal(db.sites[0].category_id, db.sites[1].category_id);
  } finally { first.finish(); second.finish(); }
});

test('并发重复 URL 在调用方取得命名锁后重新检查并拒绝', async () => {
  const db = database();
  const first = connection(db);
  const second = connection(db);
  try {
    await first.acquire();
    await publishSubmission(first, record);
    const rejected = assert.rejects(second.acquire().then(() => publishSubmission(second, { ...record, id: otherId })), status(409));
    first.finish();
    await rejected;
    assert.equal(db.sites.length, 1);
  } finally { first.finish(); second.finish(); }
});

test('数据库写入失败原样上抛，事务收尾留给调用方；SQL 不拼用户数据', async () => {
  const conn = connection();
  const execute = conn.execute.bind(conn);
  const failure = new Error('fake write failure');
  conn.execute = async (sql, values) => {
    assert.ok(!sql.includes(record.name));
    assert.ok(!sql.includes(record.url));
    if (sql.startsWith('INSERT INTO nav_sites ')) throw failure;
    return execute(sql, values);
  };
  await conn.acquire();
  try { await assert.rejects(publishSubmission(conn, record), error => error === failure); }
  finally { conn.finish(); }
});
