import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { NOTIFICATION_SCHEMA_STATEMENTS } from '../src/server/notifications-schema.ts';

/** DDL 隐式提交，禁止声称整体回滚；串行命名锁保护检查后 ALTER。不读私人 payload。 */
export async function migrateNotifications(c) {
  const [locked] = await c.query("SELECT GET_LOCK('nav-notifications:migrate', 10) AS acquired");
  if (Number(locked[0]?.acquired) !== 1) throw new Error('通知迁移锁获取失败。');
  try {
    const [tables] = await c.query(`SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('nav_users','nav_submissions','nav_sites','nav_user_records','nav_notifications')`);
    for (const name of ['nav_users', 'nav_submissions', 'nav_sites', 'nav_user_records']) {
      if (!tables.some(row => row.TABLE_NAME === name && row.ENGINE?.toLowerCase() === 'innodb')) {
        throw new Error(`请先完成账号、个人记录、站点及提交基础迁移，并确认 ${name} 为 InnoDB。`);
      }
    }
    const existing = tables.find(row => row.TABLE_NAME === 'nav_notifications');
    if (existing && existing.ENGINE?.toLowerCase() !== 'innodb') throw new Error('通知表必须为 InnoDB，未自动改动已有表。');
    const [columns] = await c.query(`SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nav_submissions' AND COLUMN_NAME = 'user_id'`);
    if (!columns.length) {
      await c.query('ALTER TABLE nav_submissions ADD COLUMN user_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL');
    } else if (columns[0].COLUMN_TYPE.toLowerCase() !== 'char(36)' || columns[0].IS_NULLABLE !== 'YES' || columns[0].COLLATION_NAME !== 'ascii_bin') {
      throw new Error('已有 user_id 结构不兼容，停止迁移，未猜测或覆盖历史归属。');
    }
    for (const sql of NOTIFICATION_SCHEMA_STATEMENTS) await c.query(sql);
    const [notificationColumns] = await c.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nav_notifications'`);
    for (const name of ['id','event_key','kind','visibility','recipient_user_id','title','body','status','reason','site_id','submission_id','created_at']) {
      if (!notificationColumns.some(row => row.COLUMN_NAME === name)) throw new Error('已有通知表结构不兼容，请人工核对；未覆盖已有表。');
    }
    const [indexes] = await c.query(`SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'nav_notifications'`);
    if (!indexes.some(row => Number(row.NON_UNIQUE) === 0 && row.COLUMN_NAME === 'event_key' &&
      indexes.filter(other => other.INDEX_NAME === row.INDEX_NAME).length === 1)) {
      throw new Error('通知 event_key 缺少单列唯一索引，请人工核对，未自动去重或删除。');
    }
  } finally {
    const [rows] = await c.query("SELECT RELEASE_LOCK('nav-notifications:migrate') AS released");
    if (Number(rows[0]?.released) !== 1) { c.destroy(); throw new Error('迁移连接释放锁失败，连接已销毁。'); }
  }
}
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log('预览（不连接数据库）：检查 InnoDB 基础表；增量添加 nullable user_id；创建通知表及索引。不回填历史 owner，不清库。应用：node --env-file-if-exists=.env scripts/迁移通知与提交归属.mjs --apply');
    return;
  }
  if (args.length !== 1 || args[0] !== '--apply') throw new Error('只允许无参数预览，或显式 --apply。');
  const { createConnection } = await import('mysql2/promise');
  const { getMySqlOptions, getStorageDriver } = await import('../src/server/database-config.ts');
  const { toConnectionOptions } = await import('./管理数据库.mjs');
  if (getStorageDriver() !== 'mysql') throw new Error('仅允许 MySQL 模式显式迁移。');
  const c = await createConnection(toConnectionOptions(getMySqlOptions()));
  try { await migrateNotifications(c); console.log('通知与提交归属增量迁移完成；历史匿名归属保持 NULL。'); }
  finally { await c.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('迁移失败：请核对基础表、InnoDB、已有列/唯一索引结构及配置。DDL 可能部分完成，修复后可重复 --apply；未清库、未回填归属。'); process.exitCode = 1; });
}
