import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getStorageDriver, getMySqlOptions } from '../src/server/database-config.ts';
import { decodeNavigationRows } from '../src/server/mysql-reader.ts';

const env = { MYSQL_HOST: 'db.example.test', MYSQL_PORT: '3306', MYSQL_DATABASE: 'navigationwebsite',
  MYSQL_USER: 'navigationWebsite', MYSQL_PASSWORD: '  pa#ss@:/word  ' };
const raw = JSON.parse(readFileSync(new URL('../src/data/导航数据.json', import.meta.url), 'utf8'));
const categories = raw.categories.map((payload) => ({ id: payload.id, slug: payload.slug, payload }));
const sites = raw.sites.map((payload) => ({ id: payload.id, slug: payload.slug, category_id: payload.category, payload }));

test('数据库默认保持seed，明确切换mysql，无效模式报错', () => {
  assert.equal(getStorageDriver({}), 'seed');
  assert.equal(getStorageDriver({ NAV_STORAGE: 'mysql' }), 'mysql');
  assert.throws(() => getStorageDriver({ NAV_STORAGE: 'unknown' }), (error) => error.code === 'DATABASE_CONFIGURATION');
});
test('密码为空在配置阶段失败，特殊字符和空格不被修改', () => {
  const options = getMySqlOptions(env);
  assert.equal(options.password, env.MYSQL_PASSWORD);
  assert.equal(options.database, 'navigationwebsite');
  assert.equal(options.user, 'navigationWebsite');
  assert.equal(options.port, 3306);
  assert.equal(options.multipleStatements, false);
  for (const key of ['MYSQL_HOST', 'MYSQL_DATABASE', 'MYSQL_USER', 'MYSQL_PASSWORD']) {
    assert.throws(() => getMySqlOptions({ ...env, [key]: '' }), (error) => error.status === 503 && !error.message.includes(env.MYSQL_PASSWORD));
  }
});
test('TLS默认验证证书，不自动退回明文；错误端口和TLS配置失败', () => {
  assert.equal(getMySqlOptions(env).ssl.rejectUnauthorized, true);
  assert.equal(getMySqlOptions(env).ssl.verifyIdentity, true);
  assert.equal(getMySqlOptions({ ...env, MYSQL_SSL_MODE: 'disabled' }).ssl, undefined);
  for (const port of ['0', '65536', '-1', '3306abc', '3.3']) {
    assert.throws(() => getMySqlOptions({ ...env, MYSQL_PORT: port }));
  }
  assert.throws(() => getMySqlOptions({ ...env, MYSQL_SSL_MODE: 'preferred' }));
  assert.throws(() => getMySqlOptions({ ...env, MYSQL_SSL_CA: 'non-existent-ca-file' }));
});
test('数据库行完整还原2400条记录，重算分类数量，支持mysql2对象及JSON字符串', () => {
  const decoded = decodeNavigationRows(categories, sites);
  assert.equal(decoded.categories.length, 18);
  assert.equal(decoded.sites.length, 2400);
  assert.deepEqual(decoded.sites, raw.sites);
  assert.deepEqual(decoded.categories, raw.categories);
  const changed = structuredClone(categories);
  changed[0].payload.count = 99999;
  const result = decodeNavigationRows(changed.map((row) => ({ ...row, payload: JSON.stringify(row.payload) })), sites);
  assert.equal(result.categories[0].count, raw.categories[0].count);
});
test('空库不会冒充成功或回退种子数据', () => {
  assert.throws(() => decodeNavigationRows([], []), (error) => error.code === 'DATABASE_NOT_INITIALIZED');
});
for (const [name, mutate] of [
  ['JSON损坏', (_categories, rows) => { rows[0].payload = '{broken'; }],
  ['主键不一致', (_categories, rows) => { rows[0].id = 'different'; }],
  ['slug不一致', (_categories, rows) => { rows[0].slug = 'different'; }],
  ['分类不一致', (_categories, rows) => { rows[0].category_id = 'different'; }],
  ['分类占用API路由', (rows) => { rows[0].slug = rows[0].payload.slug = 'api'; }],
  ['不安全网址', (_categories, rows) => { rows[0].payload.url = 'javascript:alert(1)'; }],
  ['缺少搜索字段', (_categories, rows) => { rows[0].payload.aliases = null; }],
  ['未知图标类型', (_categories, rows) => { rows[0].payload.icon = { type: 'bad', value: 'x' }; }],
  ['重复站点', (_categories, rows) => { rows.push(rows[0]); }],
  ['重复分类', (rows) => { rows.push(rows[0]); }],
]) {
  test(`拒绝数据库数据异常：${name}`, () => {
    const c = structuredClone(categories); const s = structuredClone(sites);
    mutate(c, s);
    assert.throws(() => decodeNavigationRows(c, s), (error) => error.status === 503);
  });
}

