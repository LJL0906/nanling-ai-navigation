import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMySqlOptions } from '../src/server/database-config.ts';
import { SCHEMA_STATEMENTS } from '../src/server/database-schema.ts';
import { validateNavigationData } from './校验导航数据.mjs';

export const IMPORT_LOCK_NAME = 'nanling_navigation_initial_import';
const INSERT_CATEGORY = 'INSERT INTO nav_categories (id, slug, sort_order, payload) VALUES (?, ?, ?, ?)';
const INSERT_SITE = 'INSERT INTO nav_sites (id, category_id, slug, sort_order, payload) VALUES (?, ?, ?, ?, ?)';
const DATA_URL = new URL('../src/data/导航数据.json', import.meta.url);
const LEGACY_URL = new URL('../src/data/sites.json', import.meta.url);
const SAFE_FAILURES = Object.freeze({
  arguments: '参数错误：用法 check | migrate --apply | import --apply。',
  authorization: '缺少写入授权：必须显式提供 --apply；未连接数据库。',
  data: '数据校验失败：请检查导航数据与旧精选数据；未连接数据库。',
  configuration: '数据库配置无效或缺少密码；未连接数据库。',
  authentication: '数据库认证失败：请检查账号授权与凭据。',
  permission: '数据库权限不足：请检查目标库和操作权限。',
  network: '数据库连接失败：请检查网络、主机与端口。',
  tls: '数据库 TLS 验证失败：请检查证书与 TLS 配置。',
  schema: '数据库表结构不可用：请先检查迁移状态与版本。',
  engine: '导入被拒绝：当前数据库须同时存在 nav_categories、nav_sites 两表，且存储引擎均为 InnoDB；未启动事务或写入。',
  locked: '导入被拒绝：另一个初始化任务持有导入锁，请稍后重试。',
  nonempty: '导入被拒绝：目标表非空，不允许重复导入或覆盖已有数据。',
  cleanup: '数据库会话清理失败：请检查连接与锁状态，不要直接重复导入。',
  database: '数据库操作失败：未确认成功，请检查数据库状态；未输出驱动错误详情。',
});

class SafeFailure extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

/** 仅依据白名单错误码分类，绝不输出 message、SQL、连接串或配置对象。 */
export function classifyDatabaseError(error) {
  if (error instanceof SafeFailure) return error.kind;
  const code = typeof error?.code === 'string' ? error.code : '';
  if (['ER_ACCESS_DENIED_ERROR', 'ER_NOT_SUPPORTED_AUTH_MODE'].includes(code)) return 'authentication';
  if (['ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(code)) return 'permission';
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST'].includes(code)) return 'network';
  if (['HANDSHAKE_NO_SSL_SUPPORT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID',
    'ERR_SSL_WRONG_VERSION_NUMBER'].includes(code)) return 'tls';
  if (['ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR', 'ER_BAD_DB_ERROR', 'ER_PARSE_ERROR'].includes(code)) return 'schema';
  return 'database';
}

/** 不修改输入。先完成原有数据校验、字段边界检查和 JSON 序列化，再允许连接。 */
export function prepareImport(data, legacy) {
  try {
    if (!validateNavigationData(data, legacy).valid) throw new SafeFailure('data');
    const ascii = (value, limit) => typeof value === 'string' && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
    const order = (value) => Number.isInteger(value) && value >= 0 && value <= 2147483647;
    const categories = data.categories.map((category) => {
      if (!ascii(category.id, 64) || !ascii(category.slug, 191) || !order(category.order)) throw new SafeFailure('data');
      return [category.id, category.slug, category.order, JSON.stringify(category)];
    });
    const sites = data.sites.map((site, index) => {
      if (!ascii(site.id, 64) || !ascii(site.slug, 191) || !ascii(site.category, 64) || !order(index)
        || (Object.hasOwn(site, 'category_id') && site.category_id !== site.category)) throw new SafeFailure('data');
      // 原始站点的关联键名为 category，SQL 的 category_id 必须与之相同。
      return [site.id, site.category, site.slug, index, JSON.stringify(site)];
    });
    if (!categories.length || !sites.length) throw new SafeFailure('data');
    return { categories, sites };
  } catch { throw new SafeFailure('data'); }
}

/** PoolOptions 与 ConnectionOptions 的差集；复制后剔除，不改变主 Agent 的池配置。 */
export function toConnectionOptions(poolOptions) {
  const options = { ...poolOptions };
  for (const key of ['waitForConnections', 'connectionLimit', 'maxIdle', 'idleTimeout', 'queueLimit', 'resetOnRelease']) {
    delete options[key];
  }
  return options;
}

async function defaultCreateConnection(options) {
  const { createConnection } = await import('mysql2/promise');
  return createConnection(options);
}

async function defaultReadJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

async function checkConnection(connection) {
  const [rows] = await connection.query('SELECT DATABASE() AS selected_database, VERSION() AS server_version');
  const [tls] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
  // 输出仅限诊断白名单字段；JSON 转义控制字符，避免终端控制序列。
  const selected = rows[0]?.selected_database;
  const version = rows[0]?.server_version;
  const cipher = tls[0]?.Value;
  if (typeof version !== 'string' || (selected !== null && typeof selected !== 'string') || typeof cipher !== 'string') {
    throw new SafeFailure('database');
  }
  return [
    '数据库连通：成功（只读检查）。',
    `选择 DB：${selected === null ? '未选择' : JSON.stringify(selected)}`,
    `数据库版本：${JSON.stringify(version)}`,
    `TLS 状态：${cipher ? `已启用；cipher=${JSON.stringify(cipher)}` : '未启用'}`,
  ];
}

/**
 * 返回进程退出码。全部 IO 可注入；导入模块不连接、不读取数据或环境文件、不执行 CLI。
 * env 只交给主 Agent 提供的同步配置函数；此脚本不自动加载 .env。
 */
export async function runDatabaseCommand(argv, {
  env = process.env, getOptions = getMySqlOptions, createConnection = defaultCreateConnection,
  readJson = defaultReadJson, output = console.log, errorOutput = console.error,
} = {}) {
  const [command, ...flags] = argv;
  if (!['check', 'migrate', 'import'].includes(command) || flags.some((flag) => flag !== '--apply')
    || flags.length > 1 || (command === 'check' && flags.length)) {
    errorOutput(SAFE_FAILURES.arguments);
    return 2;
  }
  if (command !== 'check' && !flags.includes('--apply')) {
    output(command === 'migrate'
      ? '计划：为 nav_categories、nav_sites 执行 CREATE TABLE IF NOT EXISTS；不会导入数据。'
      : '计划：校验导航数据.json 和旧 sites.json，获取互斥锁，仅向两个空表事务插入原始记录。');
    errorOutput(SAFE_FAILURES.authorization);
    return 2;
  }

  let connection;
  let transaction = false;
  let locked = false;
  let failure;
  let messages = [];
  try {
    let prepared;
    if (command === 'import') {
      try {
        const data = await readJson(DATA_URL);
        const legacy = await readJson(LEGACY_URL);
        prepared = prepareImport(data, legacy);
      } catch { throw new SafeFailure('data'); }
    }
    let options;
    try { options = toConnectionOptions(getOptions(env)); }
    catch { throw new SafeFailure('configuration'); }
    connection = await createConnection(options);
    if (command === 'check') messages = await checkConnection(connection);
    if (command === 'migrate') {
      // MySQL DDL 隐式提交；不假称这两条迁移是一个可回滚事务。
      for (const sql of SCHEMA_STATEMENTS) await connection.query(sql);
      messages = ['数据库建表语句执行完成；已有表未被覆盖，未执行数据导入。'];
    }
    if (command === 'import') {
      const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [IMPORT_LOCK_NAME]);
      if (Number(lockRows[0]?.acquired) !== 1) throw new SafeFailure('locked');
      locked = true;
      // IF NOT EXISTS 不会修复已有 MyISAM 表；先确认两表支持事务，再允许任何写入。
      const [tables] = await connection.query(
        "SELECT TABLE_NAME AS table_name, ENGINE AS engine FROM information_schema.TABLES "
        + "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('nav_categories', 'nav_sites')",
      );
      if (tables.length !== 2 || !['nav_categories', 'nav_sites'].every(
        (name) => tables.some((table) => table.table_name === name && table.engine === 'InnoDB'),
      )) throw new SafeFailure('engine');
      await connection.beginTransaction();
      transaction = true;
      const [categories] = await connection.query('SELECT id FROM nav_categories LIMIT 1 FOR UPDATE');
      const [sites] = await connection.query('SELECT id FROM nav_sites LIMIT 1 FOR UPDATE');
      if (categories.length || sites.length) throw new SafeFailure('nonempty');
      for (const values of prepared.categories) await connection.execute(INSERT_CATEGORY, values);
      for (const values of prepared.sites) await connection.execute(INSERT_SITE, values);
      await connection.commit();
      transaction = false;
      messages = [`空表初始化成功：${prepared.categories.length} 个分类，${prepared.sites.length} 个站点；仅 INSERT，原始 payload 已保留。`];
    }
  } catch (error) {
    failure = classifyDatabaseError(error);
  } finally {
    if (transaction) {
      try { await connection.rollback(); }
      catch { failure = 'cleanup'; }
    }
    if (locked) {
      try {
        const [rows] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [IMPORT_LOCK_NAME]);
        if (Number(rows[0]?.released) !== 1) throw new SafeFailure('cleanup');
      } catch { failure = 'cleanup'; }
    }
    if (connection) {
      try { await connection.end(); }
      catch { failure = 'cleanup'; }
    }
  }
  if (failure) { errorOutput(SAFE_FAILURES[failure]); return 1; }
  messages.forEach((message) => output(message));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runDatabaseCommand(process.argv.slice(2));
}
