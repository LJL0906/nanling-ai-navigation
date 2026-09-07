import { createPool, type Pool, type PoolConnection, type RowDataPacket } from 'mysql2/promise';
import { getMySqlOptions } from './database-config.ts';
import { HttpError } from './http.ts';
import { validateMenus, menuRevision } from './menu-validation.ts';
import type { MenuSeedItem } from './menu-seed.ts';

let pool: Pool | undefined;
export interface MenuSnapshot { menus: MenuSeedItem[]; revision: string; writable: boolean }
export function decodeMenuRows(rows: RowDataPacket[]): MenuSeedItem[] {
  try {
    if (rows.some(row => ![0, 1, true, false].includes(row.enabled))) throw new Error('Invalid enabled');
    return validateMenus(rows.map(r => ({id:r.id,parentId:r.parent_id,location:r.location,kind:r.kind,label:r.label,
      href:r.href,icon:r.icon,sortOrder:r.sort_order,enabled:r.enabled === 1 || r.enabled === true,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload})));
  } catch { throw new HttpError(503,'MENU_DATA_INVALID','数据库菜单数据无效或未初始化，请检查菜单表。'); }
}
export const toMenuSnapshot = (menus: MenuSeedItem[]): MenuSnapshot => ({menus, revision:menuRevision(menus), writable:true});
async function withConnection<T>(action: (connection: PoolConnection) => Promise<T>): Promise<T> {
  let connection: PoolConnection | undefined;
  try {
    pool ??= createPool(getMySqlOptions());
    connection = await pool.getConnection();
    return await action(connection);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503,'MENU_DATABASE_UNAVAILABLE','菜单数据库操作失败，请稍后重试。');
  } finally { connection?.release(); }
}
export const readMysqlMenus = () => withConnection(async connection => {
  const [rows] = await connection.query<RowDataPacket[]>('SELECT * FROM nav_menus');
  return toMenuSnapshot(decodeMenuRows(rows));
});

/** 比较版本与提交在同一事务内完成；共享初始化锁，避免导入与后台写入互相覆盖。 */
export async function writeMenuTransaction(connection: PoolConnection, menus: MenuSeedItem[], revision: string): Promise<MenuSnapshot> {
  let locked = false;
  let transaction = false;
  try {
    const [lockRows] = await connection.execute<RowDataPacket[]>('SELECT GET_LOCK(?, 5) AS acquired', ['nanling_menu_initial_import']);
    if (Number(lockRows[0]?.acquired) !== 1) throw new HttpError(409,'MENU_BUSY','其他操作正在保存菜单，请稍后重试。');
    locked = true;
    const [tables] = await connection.query<RowDataPacket[]>("SELECT ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nav_menus'");
    if (tables.length !== 1 || tables[0].engine !== 'InnoDB') throw new HttpError(503,'MENU_SCHEMA_INVALID','菜单表需要 InnoDB 事务支持。');
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.beginTransaction(); transaction = true;
    const [rows] = await connection.query<RowDataPacket[]>('SELECT * FROM nav_menus FOR UPDATE');
    const current = decodeMenuRows(rows);
    if (menuRevision(current) !== revision) throw new HttpError(409,'MENU_CONFLICT','菜单已被其他操作修改，请重新加载后再编辑。');
    const [categories] = await connection.query<RowDataPacket[]>('SELECT slug FROM nav_categories');
    const slugs = new Set(categories.map(c=>c.slug));
    if (menus.some(m=>m.kind === 'category' && !slugs.has(m.payload.homeAnchor))) throw new HttpError(400,'INVALID_MENU_CATEGORY','分类菜单必须引用已有分类。');
    if (menuRevision(menus) === revision) {
      await connection.commit(); transaction = false;
      return toMenuSnapshot(current);
    }
    // 仅在当前事务中暂时解除父引用，允许原子移动、删除分组与子项；不会关闭外键检查。
    await connection.query('UPDATE nav_menus SET parent_id = NULL WHERE parent_id IS NOT NULL');
    const wanted = new Set(menus.map(m=>m.id));
    for (const old of current) if (!wanted.has(old.id)) await connection.execute('DELETE FROM nav_menus WHERE id = ?', [old.id]);
    for (const m of menus) {
      await connection.execute('INSERT INTO nav_menus (id,parent_id,location,kind,label,href,icon,sort_order,enabled,payload) VALUES (?,NULL,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE location=VALUES(location),kind=VALUES(kind),label=VALUES(label),href=VALUES(href),icon=VALUES(icon),sort_order=VALUES(sort_order),enabled=VALUES(enabled),payload=VALUES(payload)',
        [m.id,m.location,m.kind,m.label,m.href,m.icon,m.sortOrder,Number(m.enabled),JSON.stringify(m.payload)]);
    }
    for (const m of menus) if (m.parentId !== null) await connection.execute('UPDATE nav_menus SET parent_id = ? WHERE id = ?', [m.parentId,m.id]);
    const [saved] = await connection.query<RowDataPacket[]>('SELECT * FROM nav_menus');
    const result = decodeMenuRows(saved);
    if (menuRevision(result) !== menuRevision(menus)) throw new HttpError(503,'MENU_SAVE_MISMATCH','菜单写入校验失败，已取消本次保存。');
    await connection.commit(); transaction = false;
    return toMenuSnapshot(result);
  } finally {
    try { if (transaction) await connection.rollback(); }
    finally {
      if (locked) {
        const [released] = await connection.execute<RowDataPacket[]>('SELECT RELEASE_LOCK(?) AS released', ['nanling_menu_initial_import']);
        if (Number(released[0]?.released) !== 1) throw new HttpError(503,'MENU_LOCK_RELEASE_FAILED','菜单锁释放异常，请重新加载确认保存状态。');
      }
    }
  }
}
export const saveMysqlMenus = (menus: MenuSeedItem[], revision: string) => withConnection(connection => writeMenuTransaction(connection,menus,revision));
