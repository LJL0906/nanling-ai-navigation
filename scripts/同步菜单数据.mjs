import { isDeepStrictEqual } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';
import { getMySqlOptions } from '../src/server/database-config.ts';
import { MENU_SCHEMA_STATEMENTS } from '../src/server/menu-schema.ts';
import { buildMenuSeed } from '../src/server/menu-seed.ts';
import { toConnectionOptions } from './管理数据库.mjs';

const LOCK = 'nanling_menu_initial_import';
const parse = (value) => typeof value === 'string' ? JSON.parse(value) : value;
const same = (a, b) => isDeepStrictEqual(a, b);

/** 只允许空表初始化或完全一致的重复执行，不把初始化变成覆盖运营数据。 */
export async function syncMenuSeed(connection, seed) {
  let locked = false;
  let transaction = false;
  try {
    const [locks] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [LOCK]);
    if (Number(locks[0]?.acquired) !== 1) throw new Error('无法获取菜单初始化锁');
    locked = true;
    // DDL 会隐式提交：建表在事务前进行，不宣称建表可整体回滚。
    for (const sql of MENU_SCHEMA_STATEMENTS) await connection.query(sql);
    const [engines] = await connection.query("SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('nav_menus', 'nav_settings')");
    if (engines.length !== 2 || !['nav_menus', 'nav_settings'].every(name => engines.some(t => t.name === name && t.engine === 'InnoDB'))) {
      throw new Error('菜单表必须使用 InnoDB');
    }
    await connection.beginTransaction();
    transaction = true;
    const [menus] = await connection.query('SELECT * FROM nav_menus FOR UPDATE');
    const [settings] = await connection.query('SELECT * FROM nav_settings FOR UPDATE');
    if (menus.length || settings.length) {
      const storedMenus = new Map(menus.map(row => [row.id, {
        id: row.id, parentId: row.parent_id, location: row.location, kind: row.kind,
        label: row.label, href: row.href, icon: row.icon, sortOrder: row.sort_order,
        enabled: Boolean(row.enabled), payload: parse(row.payload),
      }]));
      const storedSettings = new Map(settings.map(row => [row.setting_key, parse(row.payload)]));
      if (menus.length !== seed.menus.length || settings.length !== seed.settings.length
        || !seed.menus.every(row => same(storedMenus.get(row.id), row))
        || !seed.settings.every(row => same(storedSettings.get(row.key), row.value))) {
        throw new Error('已存在不同菜单或配置，拒绝覆盖');
      }
      await connection.commit(); transaction = false;
      return { inserted: false, menus: menus.length, settings: settings.length };
    }
    for (const m of seed.menus) {
      await connection.execute('INSERT INTO nav_menus (id,parent_id,location,kind,label,href,icon,sort_order,enabled,payload) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [m.id, m.parentId, m.location, m.kind, m.label, m.href, m.icon, m.sortOrder, Number(m.enabled), JSON.stringify(m.payload)]);
    }
    for (const s of seed.settings) {
      await connection.execute('INSERT INTO nav_settings (setting_key,payload) VALUES (?,?)', [s.key, JSON.stringify(s.value)]);
    }
    await connection.commit(); transaction = false;
    return { inserted: true, menus: seed.menus.length, settings: seed.settings.length };
  } finally {
    try { if (transaction) await connection.rollback(); }
    finally {
      if (locked) {
        const [rows] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [LOCK]);
        if (Number(rows[0]?.released) !== 1) throw new Error('释放菜单初始化锁失败');
      }
    }
  }
}

export async function runMenuSync(argv, { connect = createConnection, output = console.log, errorOutput = console.error } = {}) {
  // 种子构造发生在连接前；默认仅离线预览。
  let connection;
  try {
    if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--apply')) throw new Error('参数无效');
    const seed = buildMenuSeed();
    if (!argv.length) {
      output(`预览：${seed.menus.length} 条菜单、${seed.settings.length} 项配置；加 --apply 才会建表并写入。`);
      return 0;
    }
    connection = await connect(toConnectionOptions(getMySqlOptions()));
    const result = await syncMenuSeed(connection, seed);
    output(`${result.inserted ? '初始化成功' : '内容一致，无需重复写入'}：${result.menus} 条菜单、${result.settings} 项配置。`);
    return 0;
  } catch {
    errorOutput('菜单同步未确认成功：请检查连接、表结构及已有数据；不会覆盖不同数据，未输出驱动详情。');
    return 1;
  } finally { if (connection) await connection.end(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runMenuSync(process.argv.slice(2));
}
