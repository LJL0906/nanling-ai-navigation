import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';
import { getMySqlOptions } from '../src/server/database-config.ts';
import { decodeNavigationRows } from '../src/server/mysql-reader.ts';
import { adaptNavigation } from '../src/lib/adapt-navigation.ts';
import { buildMenuSeed } from '../src/server/menu-seed.ts';
import { toConnectionOptions } from './管理数据库.mjs';

const raw = JSON.parse(readFileSync(new URL('../src/data/导航数据.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(readFileSync(new URL('../src/data/sites.json', import.meta.url), 'utf8'));
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
let connection;
try {
  connection = await createConnection(toConnectionOptions(getMySqlOptions()));
  await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
  const [categories] = await connection.query('SELECT id,slug,sort_order,payload FROM nav_categories ORDER BY sort_order,id');
  const [sites] = await connection.query('SELECT id,category_id,slug,sort_order,payload FROM nav_sites ORDER BY sort_order,id');
  assert.deepEqual(categories.map(r => parse(r.payload)), [...raw.categories].sort((a,b) => a.order-b.order || a.id.localeCompare(b.id)));
  assert.deepEqual(sites.map(r => parse(r.payload)), raw.sites);
  const expectedOrders = new Map(raw.categories.map(c => [c.id,c.order]));
  assert.ok(categories.every(c => c.sort_order === expectedOrders.get(c.id)));
  assert.ok(sites.every((s,i) => s.sort_order === i));
  const snapshot = adaptNavigation(decodeNavigationRows(categories, sites), legacy);
  assert.deepEqual(snapshot, adaptNavigation(raw, legacy));
  const seed = buildMenuSeed();
  const [menus] = await connection.query('SELECT * FROM nav_menus');
  const [settings] = await connection.query('SELECT * FROM nav_settings');
  const storedMenus = new Map(menus.map(r => [r.id, {id:r.id,parentId:r.parent_id,location:r.location,kind:r.kind,label:r.label,href:r.href,icon:r.icon,sortOrder:r.sort_order,enabled:Boolean(r.enabled),payload:parse(r.payload)}]));
  const storedSettings = new Map(settings.map(r => [r.setting_key, parse(r.payload)]));
  assert.equal(menus.length, seed.menus.length);
  assert.equal(settings.length, seed.settings.length);
  for (const row of seed.menus) assert.deepEqual(storedMenus.get(row.id), row);
  for (const row of seed.settings) assert.deepEqual(storedSettings.get(row.key), row.value);
  await connection.commit();
  console.log(`只读全量校验通过：${categories.length} 分类、${sites.length} 站点、${menus.length} 菜单、${settings.length} 配置；数据库与当前静态数据及页面适配结果一致。`);
} catch {
  process.exitCode = 1;
  try { await connection?.rollback(); } catch { /* 不输出驱动细节 */ }
  console.error('全量校验失败：请检查连接、数据完整性或静态源是否改变；未输出数据库内容或凭据。');
} finally { if (connection) await connection.end(); }
