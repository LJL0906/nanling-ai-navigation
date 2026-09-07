import { createConnection } from 'mysql2/promise';
import { getMySqlOptions, getStorageDriver } from '../src/server/database-config.ts';
import { toConnectionOptions } from './管理数据库.mjs';
import { ACCOUNT_SCHEMA_STATEMENTS } from '../src/server/account-schema.ts';
import { PERSONAL_SCHEMA_STATEMENTS } from '../src/server/personal-schema.ts';
const apply = process.argv.slice(2);
if (apply.length !== 1 || apply[0] !== '--apply') {
  console.log('预览：将创建用户、会话、个人记录表（不覆盖已有表）。执行 npm run db:migrate-accounts -- --apply 应用。');
} else {
  let connection;
  try {
    if (getStorageDriver() !== 'mysql') throw new Error();
    connection = await createConnection(toConnectionOptions(getMySqlOptions()));
    for (const sql of [...ACCOUNT_SCHEMA_STATEMENTS,...PERSONAL_SCHEMA_STATEMENTS]) await connection.query(sql);
    console.log('用户、会话、个人记录表迁移完成；没有修改已有站点、菜单或管理员数据。');
  } catch {
    console.error('账号迁移失败，请检查 MySQL 配置、外键依赖及数据库授权；DDL可能部分成功，修复后可重复执行。');
    process.exitCode = 1;
  } finally { if (connection) await connection.end(); }
}
