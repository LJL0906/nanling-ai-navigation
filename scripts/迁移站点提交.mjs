import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getMySqlOptions } from '../src/server/database-config.ts';
import { submissionDirectory } from '../src/server/submission-idempotency.ts';
import { SUBMISSION_SCHEMA_STATEMENTS } from '../src/server/submission-schema.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = () => { throw new Error('迁移校验失败：存在无效或冲突记录，请检查私有源目录。'); };
export function validateLegacySubmission(record, filename) {
  if (!record || Array.isArray(record) || !uuid.test(record.id) || filename !== `${record.id}.json`
    || !['pending', 'approved', 'rejected'].includes(record.status)
    || !Number.isFinite(Date.parse(record.createdAt))) fail();
  for (const key of ['name', 'url', 'categoryId', 'customCategory', 'iconUrl', 'iconData']) {
    if (typeof record[key] !== 'string') fail();
  }
  if (!record.name.trim() || record.name.length > 100 || record.url.length > 2048
    || (record.remark !== undefined && (typeof record.remark !== 'string' || record.remark.length > 500))) fail();
  try { if (!['http:', 'https:'].includes(new URL(record.url).protocol)) fail(); } catch { fail(); }
  if (record.requestKey !== undefined && (record.requestKey !== record.id || !/^[a-f0-9]{64}$/.test(record.requestDigest))) fail();
  if (record.reviewedAt != null && !Number.isFinite(Date.parse(record.reviewedAt))) fail();
  return record;
}
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** 先读取并校验全部旧记录；只处理UUID JSON，不跟随符号链接，不修改源文件。 */
export async function readLegacySubmissions(directory) {
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const file of files) {
    if (file.name.endsWith('.review.lock') || file.name.endsWith('.tmp')) {
      throw new Error('发现旧写入锁或临时文件，请停止旧版本写入并核对后迁移。');
    }
    if (!file.name.endsWith('.json')) continue;
    const path = join(directory, file.name);
    const info = await lstat(path);
    if (!file.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) fail();
    records.push(validateLegacySubmission(JSON.parse(await readFile(path, 'utf8')), file.name));
  }
  return records;
}

export async function importLegacySubmissions(connection, records) {
  let inserted = 0; let skipped = 0;
  await connection.beginTransaction();
  try {
    for (const record of records) {
      const [rows] = await connection.execute('SELECT payload FROM nav_submissions WHERE id = ? FOR UPDATE', [record.id]);
      if (rows.length) {
        const saved = typeof rows[0].payload === 'string' ? JSON.parse(rows[0].payload) : rows[0].payload;
        if (digest(saved) !== digest(record)) throw new Error('同编号数据库记录与旧文件不同，已回滚；不会覆盖数据库中的审核结果。');
        skipped++; continue;
      }
      await connection.execute(
        'INSERT INTO nav_submissions (id, request_digest, status, payload, created_at, reviewed_at, published_site_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [record.id, record.requestDigest ?? null, record.status, JSON.stringify(record), new Date(record.createdAt).toISOString().slice(0, 23).replace('T', ' '),
          record.reviewedAt ? new Date(record.reviewedAt).toISOString().slice(0, 23).replace('T', ' ') : null, null]);
      inserted++;
    }
    await connection.commit();
    return { inserted, skipped };
  } catch(error) { await connection.rollback(); throw error; }
}

async function main() {
  const mode = process.argv[2] ?? 'check';
  if (!['check', 'migrate', 'import'].includes(mode) || process.argv.length > 4) {
    throw new Error('用法：node --env-file-if-exists=.env scripts/迁移站点提交.mjs check|migrate|import [旧目录]');
  }
  const directory = submissionDirectory(process.argv[3]);
  const records = mode === 'migrate' ? [] : await readLegacySubmissions(directory);
  if (mode === 'check') { console.log(JSON.stringify({ mode, legacyRecords: records.length, sourceFilesModified: false })); return; }
  const { createConnection } = await import('mysql2/promise');
  const options = { ...getMySqlOptions() };
  for (const key of ['connectionLimit', 'maxIdle', 'idleTimeout', 'waitForConnections', 'queueLimit']) delete options[key];
  const connection = await createConnection(options);
  try {
    const [lock] = await connection.query("SELECT GET_LOCK('nav-submissions:migration', 10) AS acquired");
    if (Number(lock[0].acquired) !== 1) throw new Error('迁移任务正运行，请稍后重试。');
    try {
      for (const sql of SUBMISSION_SCHEMA_STATEMENTS) await connection.query(sql);
      const result = mode === 'import' ? await importLegacySubmissions(connection, records) : {};
      const [count] = await connection.query('SELECT COUNT(*) AS total FROM nav_submissions');
      console.log(JSON.stringify({ mode, ...result, databaseRecords: Number(count[0].total), sourceFilesModified: false }));
    } finally { await connection.query("SELECT RELEASE_LOCK('nav-submissions:migration')"); }
  } finally { await connection.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('站点提交迁移失败：请检查数据库连接、授权、旧数据和迁移冲突；未删除任何源文件。'); process.exitCode = 1; });
}

