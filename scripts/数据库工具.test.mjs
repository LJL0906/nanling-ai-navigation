import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFile } from 'node:fs/promises';
import { SCHEMA_STATEMENTS } from '../src/server/database-schema.ts';

// 只测试本子任务：替换主 Agent 的配置入口，不读取真实配置/环境；硬阻断真实驱动。
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '../src/server/database-config.ts') {
      return { url: 'data:text/javascript,export function getMySqlOptions() { throw new Error("配置测试替身"); }', shortCircuit: true };
    }
    if (specifier === 'mysql2/promise') throw new Error('测试禁止加载真实 MySQL 驱动');
    return nextResolve(specifier, context);
  },
});
const { runDatabaseCommand, prepareImport, classifyDatabaseError, toConnectionOptions, IMPORT_LOCK_NAME } = await import('./管理数据库.mjs');
after(() => hooks.deregister());

function fixture() {
  const legacy = { categories: [{ slug: 'ai', sites: [{ slug: 'chat', url: 'https://example.com/' }] }] };
  const data = {
    categories: [{ id: 'ai', slug: 'ai', name: '测试分类', count: 1, icon: 'lucide:sparkles', order: 3, color: '#3777f5' }],
    sites: [{
      id: 'site_0', slug: 'chat', name: "测试'; DROP TABLE nav_sites; --", category: 'ai',
      url: 'https://example.com/', alternateUrls: [], tags: [], description: '', domain: 'example.com',
      aliases: [], sourceCategories: [], icon: null,
      sources: [{ dataset: 'sites.json', recordId: 'ai/chat', originalUrl: 'https://example.com/' }],
      verification: { status: 'unverified', checkedAt: null },
      classification: { category: 'ai', confidence: 'high', reason: '测试数据' },
      extra: { untouched: ['中文', null, 7] },
    }],
    meta: {
      stats: { sourceRecords: 1, parsedValidRecords: 1, uniqueSites: 1, duplicateRecordsMerged: 0,
        duplicateGroups: 0, excludedRecords: 0, categories: 1, reclassified: 0, lowConfidence: 0 },
      sources: [{ file: 'sites.json', recordCount: 1 }], exclusions: [],
    },
  };
  return { data, legacy };
}

function harness(settings = {}) {
  const source = fixture();
  const calls = [];
  const output = [];
  const errors = [];
  const stored = { categories: settings.categories ?? [], sites: settings.sites ?? [] };
  let pending;
  const driverError = () => Object.assign(new Error('TEST_ONLY_SECRET_DO_NOT_PRINT mysql://private'), { code: settings.code });
  const connection = {
    async query(sql) {
      calls.push(['query', sql]);
      if (settings.failQuery && sql.includes(settings.failQuery)) throw driverError();
      if (sql.includes('FROM information_schema.TABLES')) return [settings.tables ?? [
        { table_name: 'nav_categories', engine: 'InnoDB' }, { table_name: 'nav_sites', engine: 'InnoDB' },
      ]];
      if (sql.startsWith('SELECT DATABASE()')) return [[{ selected_database: 'test_navigation', server_version: '5.7.44' }]];
      if (sql.startsWith('SHOW SESSION')) return [[{ Variable_name: 'Ssl_cipher', Value: settings.cipher ?? 'TEST_TLS_CIPHER' }]];
      if (sql.includes('FROM nav_categories')) return [stored.categories];
      if (sql.includes('FROM nav_sites')) return [stored.sites];
      if (SCHEMA_STATEMENTS.includes(sql)) return [{ affectedRows: 0 }];
      throw new Error(`未预期的 SQL：${sql}`);
    },
    async execute(sql, values) {
      calls.push(['execute', sql, values]);
      if (sql.includes('GET_LOCK')) return [[{ acquired: settings.lock === undefined ? 1 : settings.lock }]];
      if (sql.includes('RELEASE_LOCK')) {
        if (settings.failRelease) throw driverError();
        return [[{ released: settings.release === undefined ? 1 : settings.release }]];
      }
      if (settings.failInsert && sql.includes(settings.failInsert)) throw driverError();
      assert.ok(pending, '所有 INSERT 必须在事务中');
      const table = sql.startsWith('INSERT INTO nav_categories ') ? 'categories' : 'sites';
      pending[table].push([...values]);
      return [{ affectedRows: 1 }];
    },
    async beginTransaction() {
      calls.push(['beginTransaction']);
      if (settings.failBegin) throw driverError();
      pending = { categories: [], sites: [] };
    },
    async commit() {
      calls.push(['commit']);
      if (settings.failCommit) throw driverError();
      stored.categories.push(...pending.categories);
      stored.sites.push(...pending.sites);
      pending = undefined;
    },
    async rollback() {
      calls.push(['rollback']);
      pending = undefined;
      if (settings.failRollback) throw driverError();
    },
    async end() {
      calls.push(['end']);
      if (settings.failEnd) throw driverError();
    },
  };
  const dependencies = {
    env: {},
    getOptions(env) {
      calls.push(['getOptions']);
      assert.deepEqual(env, {});
      if (settings.failOptions) throw driverError();
      return {
        host: 'test.invalid', database: 'test_navigation', user: 'fake', ssl: { rejectUnauthorized: true },
        waitForConnections: true, connectionLimit: 5, maxIdle: 5, idleTimeout: 60000, queueLimit: 20, resetOnRelease: false,
      };
    },
    async createConnection(options) {
      calls.push(['connect', options]);
      for (const key of ['waitForConnections', 'connectionLimit', 'maxIdle', 'idleTimeout', 'queueLimit', 'resetOnRelease']) {
        assert.equal(Object.hasOwn(options, key), false, '单连接不得接收池专用选项');
      }
      assert.equal(options.ssl.rejectUnauthorized, true, '保留 TLS 证书校验');
      if (settings.failConnect) throw driverError();
      return connection;
    },
    async readJson(url) {
      calls.push(['readJson', decodeURIComponent(url.pathname)]);
      if (settings.failRead) throw driverError();
      return url.pathname.endsWith('/sites.json') ? source.legacy : source.data;
    },
    output: (message) => output.push(message),
    errorOutput: (message) => errors.push(message),
  };
  return { ...source, calls, output, errors, stored, dependencies, run: (argv) => runDatabaseCommand(argv, dependencies) };
}

const inserts = (h) => h.calls.filter(([kind, sql]) => kind === 'execute' && sql.startsWith('INSERT'));
const events = (h) => h.calls.map(([kind, sql]) => kind === 'query' || kind === 'execute' ? sql : kind);
const assertSafe = (h) => assert.doesNotMatch([...h.output, ...h.errors].join('\n'), /TEST_ONLY_SECRET_DO_NOT_PRINT|mysql:\/\/private|stack|DROP TABLE/);

for (const command of ['migrate', 'import']) {
  test(`${command} 无 --apply 时不读取配置/数据、不连接`, async () => {
    const h = harness();
    assert.equal(await h.run([command]), 2);
    assert.deepEqual(h.calls, []);
    assert.match(h.output.join(''), /计划/);
    assert.match(h.errors.join(''), /--apply.*未连接/);
  });
}

for (const argv of [[], ['unknown'], ['import', '--apply=true'], ['migrate', '--apply', '--apply'], ['check', '--apply'], ['check', '--bad']]) {
  test(`未知命令或参数安全拒绝：${JSON.stringify(argv)}`, async () => {
    const h = harness();
    assert.equal(await h.run(argv), 2);
    assert.deepEqual(h.calls, []);
    assert.match(h.errors[0], /参数错误/);
  });
}

test('模块导入没有自动执行 CLI；配置模块可被独立替换', async () => {
  const output = [];
  assert.equal(await runDatabaseCommand(['check'], { env: {}, errorOutput: (message) => output.push(message) }), 1);
  assert.match(output[0], /配置无效或缺少密码/);
});

test('DDL 恰好两条，固定表、InnoDB、JSON、ASCII 键与 MySQL 5.7 兼容联合索引', () => {
  assert.equal(SCHEMA_STATEMENTS.length, 2);
  for (const sql of SCHEMA_STATEMENTS) {
    assert.match(sql, /^CREATE TABLE IF NOT EXISTS nav_(categories|sites)/);
    assert.match(sql, /ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4/);
    assert.match(sql, /payload JSON NOT NULL/);
    assert.match(sql, /id VARCHAR\(64\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
    assert.match(sql, /slug VARCHAR\(191\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
    assert.doesNotMatch(sql, /\b(?:DROP|ALTER|TRUNCATE|CHECK)\b|0900/i);
  }
  assert.match(SCHEMA_STATEMENTS[0], /UNIQUE KEY uq_nav_categories_slug \(slug\)/);
  assert.match(SCHEMA_STATEMENTS[1], /UNIQUE KEY uq_nav_sites_category_slug \(category_id, slug\)/);
  assert.match(SCHEMA_STATEMENTS[1], /FOREIGN KEY \(category_id\) REFERENCES nav_categories \(id\)/);
});

test('fake migrate 仅按顺序执行两条 DDL 并结束连接', async () => {
  const h = harness();
  assert.equal(await h.run(['migrate', '--apply']), 0);
  assert.deepEqual(h.calls.filter(([kind]) => kind === 'query').map(([, sql]) => sql), SCHEMA_STATEMENTS);
  assert.equal(events(h).at(-1), 'end');
  assert.equal(inserts(h).length, 0);
});

test('空表导入：校验先于连接、参数化、事务提交、原始 payload、释放固定锁', async () => {
  const h = harness();
  const original = structuredClone({ data: h.data, legacy: h.legacy });
  assert.equal(await h.run(['import', '--apply']), 0);
  assert.deepEqual(h.calls.slice(0, 4).map(([kind]) => kind), ['readJson', 'readJson', 'getOptions', 'connect']);
  assert.deepEqual(inserts(h).map(([, sql]) => (sql.match(/\?/g) ?? []).length), [4, 5]);
  for (const [, , values] of inserts(h)) {
    assert.equal(typeof values.at(-1), 'string', 'JSON 使用序列化字符串绑定而非原始 JS 对象');
  }
  const category = h.stored.categories[0];
  const site = h.stored.sites[0];
  assert.deepEqual(category.slice(0, 3), ['ai', 'ai', 3]);
  assert.deepEqual(site.slice(0, 4), ['site_0', 'ai', 'chat', 0]);
  assert.deepEqual(JSON.parse(category[3]), h.data.categories[0]);
  assert.deepEqual(JSON.parse(site[4]), h.data.sites[0]);
  assert.deepEqual({ data: h.data, legacy: h.legacy }, original);
  for (const [, sql] of inserts(h)) assert.doesNotMatch(sql, /DROP TABLE|测试|\bUPDATE\b|\bDELETE\b|\bREPLACE\b/);
  const locked = h.calls.find(([, sql]) => typeof sql === 'string' && sql.includes('GET_LOCK'));
  assert.deepEqual(locked[2], [IMPORT_LOCK_NAME]);
  assert.deepEqual(events(h).slice(-3), ['commit', 'SELECT RELEASE_LOCK(?) AS released', 'end']);
  assert.ok(events(h).indexOf('beginTransaction') < events(h).indexOf('SELECT id FROM nav_categories LIMIT 1 FOR UPDATE'));
  assert.ok(!events(h).includes('rollback'));
  assertSafe(h);
});

test('重复导入明确拒绝，不改变已提交数据', async () => {
  const h = harness();
  assert.equal(await h.run(['import', '--apply']), 0);
  const original = structuredClone(h.stored);
  h.calls.length = 0;
  assert.equal(await h.run(['import', '--apply']), 1);
  assert.equal(inserts(h).length, 0);
  assert.deepEqual(h.stored, original);
  assert.match(h.errors[0], /非空.*重复导入/);
  assert.deepEqual(events(h).slice(-3), ['rollback', 'SELECT RELEASE_LOCK(?) AS released', 'end']);
});

for (const table of ['categories', 'sites']) {
  test(`只有 ${table} 非空也拒绝导入`, async () => {
    const h = harness({ [table]: [{ id: 'existing' }] });
    assert.equal(await h.run(['import', '--apply']), 1);
    assert.equal(inserts(h).length, 0);
    assert.ok(events(h).includes('rollback'));
    assert.match(h.errors[0], /非空/);
  });
}

for (const settings of [{ failInsert: 'nav_categories' }, { failInsert: 'nav_sites' }, { failCommit: true }]) {
  test(`事务错误 rollback 并释放锁/连接：${JSON.stringify(settings)}`, async () => {
    const h = harness(settings);
    assert.equal(await h.run(['import', '--apply']), 1);
    assert.deepEqual(h.stored, { categories: [], sites: [] });
    assert.deepEqual(events(h).slice(-3), ['rollback', 'SELECT RELEASE_LOCK(?) AS released', 'end']);
    assert.equal(h.output.length, 0);
    assertSafe(h);
  });
}

for (const lock of [0, null]) {
  test(`获取锁失败 ${lock} 不启动事务、不释放他人锁`, async () => {
    const h = harness({ lock });
    assert.equal(await h.run(['import', '--apply']), 1);
    assert.equal(inserts(h).length, 0);
    assert.ok(!events(h).includes('beginTransaction'));
    assert.ok(!events(h).includes('SELECT RELEASE_LOCK(?) AS released'));
    assert.equal(events(h).at(-1), 'end');
    assert.match(h.errors[0], /导入锁/);
  });
}

for (const mutate of [
  (h) => { h.data.categories[0].count = 8; },
  (h) => { h.data.sites[0].category = 'missing'; },
  (h) => { h.legacy.categories[0].sites[0].slug = 'lost'; },
  (h) => { h.data.sites[0].id = 'x'.repeat(65); },
  (h) => { h.data.sites[0].id = '中文'; },
  (h) => { h.data.sites[0].slug = 'x'.repeat(192); },
  (h) => { h.data.categories[0].order = 2147483648; },
  (h) => { h.data.sites[0].category_id = 'different'; },
]) {
  test(`输入校验失败先于配置与连接：${mutate.toString()}`, async () => {
    const h = harness();
    mutate(h);
    assert.equal(await h.run(['import', '--apply']), 1);
    assert.ok(!events(h).includes('getOptions'));
    assert.ok(!events(h).includes('connect'));
    assert.match(h.errors[0], /数据校验失败/);
    assertSafe(h);
  });
}

test('实际两份 JSON 可通过纯函数预检，未加载配置或驱动', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data/导航数据.json', import.meta.url), 'utf8'));
  const legacy = JSON.parse(await readFile(new URL('../src/data/sites.json', import.meta.url), 'utf8'));
  const prepared = prepareImport(data, legacy);
  assert.equal(prepared.categories.length, data.categories.length);
  assert.equal(prepared.sites.length, data.sites.length);
  assert.deepEqual(JSON.parse(prepared.sites.at(-1)[4]), data.sites.at(-1));
});

for (const cipher of ['TEST_TLS_CIPHER', '']) {
  test(`check 只读查询并报告 DB/版本/TLS：${cipher || '无 TLS'}`, async () => {
    const h = harness({ cipher });
    assert.equal(await h.run(['check']), 0);
    assert.deepEqual(events(h).slice(2), [
      'SELECT DATABASE() AS selected_database, VERSION() AS server_version', "SHOW SESSION STATUS LIKE 'Ssl_cipher'", 'end',
    ]);
    assert.match(h.output.join('\n'), /连通：成功.*\n选择 DB："test_navigation".*\n数据库版本："5.7.44".*\nTLS 状态：/);
    assert.match(h.output.at(-1), cipher ? /已启用/ : /未启用/);
    assertSafe(h);
  });
}

for (const [code, category] of [
  ['ER_ACCESS_DENIED_ERROR', 'authentication'], ['ER_TABLEACCESS_DENIED_ERROR', 'permission'],
  ['ECONNREFUSED', 'network'], ['CERT_HAS_EXPIRED', 'tls'], ['ER_NO_SUCH_TABLE', 'schema'], ['UNKNOWN', 'database'],
]) {
  test(`驱动失败只输出安全分类：${category}`, async () => {
    const h = harness({ failConnect: true, code });
    assert.equal(classifyDatabaseError({ code, message: 'private' }), category);
    assert.equal(await h.run(['check']), 1);
    assert.equal(h.errors.length, 1);
    assertSafe(h);
  });
}

for (const settings of [
  { failRead: true }, { failOptions: true }, { failBegin: true }, { failQuery: 'FROM nav_sites' },
  { failInsert: 'nav_sites', failRollback: true }, { failRelease: true }, { release: null }, { failEnd: true },
]) {
  test(`错误路径安全清理：${JSON.stringify(settings)}`, async () => {
    const h = harness(settings);
    assert.equal(await h.run(['import', '--apply']), 1);
    assert.equal(h.output.length, 0);
    if (settings.failRead || settings.failOptions) assert.ok(!events(h).includes('connect'));
    else assert.equal(events(h).at(-1), 'end');
    assertSafe(h);
  });
}

test('迁移中途失败仍结束连接，不承诺 DDL 回滚', async () => {
  const h = harness({ failQuery: 'CREATE TABLE IF NOT EXISTS nav_sites' });
  assert.equal(await h.run(['migrate', '--apply']), 1);
  assert.equal(events(h).at(-1), 'end');
  assert.ok(!events(h).includes('rollback'));
  assert.equal(h.output.length, 0);
  assertSafe(h);
});


test('单连接选项剔除全部池专用字段，不修改原配置且保留 TLS/连接字段', () => {
  const connection = {
    host: 'test.invalid', port: 3306, user: 'fake', database: 'test_navigation', charset: 'utf8mb4',
    ssl: { rejectUnauthorized: true, ca: 'TEST_ONLY_CA' }, connectTimeout: 5000,
    enableKeepAlive: true, multipleStatements: false,
  };
  const pool = Object.freeze({ ...connection, connectionLimit: 5, maxIdle: 5, queueLimit: 20,
    idleTimeout: 60000, waitForConnections: true, resetOnRelease: false });
  assert.deepEqual(toConnectionOptions(pool), connection);
  assert.equal(pool.connectionLimit, 5);
});

test('配置函数缺密码抛 503 时在 createConnection 之前阻断', async () => {
  const h = harness();
  h.dependencies.getOptions = () => {
    throw Object.assign(new Error('TEST_ONLY_SECRET_DO_NOT_PRINT'), { status: 503, code: 'DATABASE_CONFIGURATION' });
  };
  assert.equal(await h.run(['check']), 1);
  assert.ok(!events(h).includes('connect'));
  assert.match(h.errors[0], /缺少密码.*未连接数据库/);
  assertSafe(h);
});


for (const [label, tables] of [
  ['两表均不存在', []],
  ['分类表不存在', [{ table_name: 'nav_sites', engine: 'InnoDB' }]],
  ['站点表不存在', [{ table_name: 'nav_categories', engine: 'InnoDB' }]],
  ['分类表为 MyISAM', [{ table_name: 'nav_categories', engine: 'MyISAM' }, { table_name: 'nav_sites', engine: 'InnoDB' }]],
  ['站点表为 MyISAM', [{ table_name: 'nav_categories', engine: 'InnoDB' }, { table_name: 'nav_sites', engine: 'MyISAM' }]],
  ['视图或引擎未知', [{ table_name: 'nav_categories', engine: 'InnoDB' }, { table_name: 'nav_sites', engine: null }]],
]) {
  test('事务前拒绝不安全表结构：' + label, async () => {
    const h = harness({ tables });
    assert.equal(await h.run(['import', '--apply']), 1);
    assert.equal(inserts(h).length, 0);
    assert.ok(!events(h).includes('beginTransaction'));
    assert.ok(!events(h).includes('rollback'));
    assert.deepEqual(events(h).slice(-2), ['SELECT RELEASE_LOCK(?) AS released', 'end']);
    assert.match(h.errors[0], /当前数据库.*两表.*InnoDB.*未启动事务或写入/);
    assert.equal(h.output.length, 0);
    assertSafe(h);
  });
}

test('引擎检查限定当前 DATABASE() 的两张表，严格位于拿锁后、事务前', async () => {
  const h = harness();
  assert.equal(await h.run(['import', '--apply']), 0);
  const sequence = events(h);
  const position = sequence.findIndex((event) => event.includes('FROM information_schema.TABLES'));
  assert.match(sequence[position], /WHERE TABLE_SCHEMA = DATABASE\(\) AND TABLE_NAME IN \('nav_categories', 'nav_sites'\)/);
  assert.equal(sequence[position - 1], 'SELECT GET_LOCK(?, 0) AS acquired');
  assert.equal(sequence[position + 1], 'beginTransaction');
});

test('查询表引擎失败也不启动事务，并释放锁/关闭连接且不泄露驱动错误', async () => {
  const h = harness({ failQuery: 'FROM information_schema.TABLES', code: 'ER_TABLEACCESS_DENIED_ERROR' });
  assert.equal(await h.run(['import', '--apply']), 1);
  assert.equal(inserts(h).length, 0);
  assert.ok(!events(h).includes('beginTransaction'));
  assert.deepEqual(events(h).slice(-2), ['SELECT RELEASE_LOCK(?) AS released', 'end']);
  assert.match(h.errors[0], /权限不足/);
  assertSafe(h);
});
