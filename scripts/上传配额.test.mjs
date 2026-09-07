import test from 'node:test';
import assert from 'node:assert/strict';
import { withUploadQuota, createUploadQuota, uploadQuotaIpScope,
  isUploadQuotaConnectionDestroyed } from '../src/server/upload-quota.ts';
import { UPLOAD_QUOTA_SCHEMA_STATEMENTS, UPLOAD_QUOTA_CLEANUP_SQL } from '../src/server/upload-quota-schema.ts';

const MiB = 1024 * 1024;
const secret = 'mysql://private:password@internal.example';
const errorIs = (code, status = code === 'UPLOAD_BUSY' || code === 'UPLOAD_LIMIT_REACHED' ? 429 : 503) => error => {
  assert.equal(error.code, code); assert.equal(error.status, status);
  assert.doesNotMatch(`${error.stack} ${JSON.stringify(error)}`, /private|password|internal\.example/);
  assert.equal(error.cause, undefined);
  return true;
};
function database() {
  return { rows: new Map(), locks: new Map(), day: '2026-09-07', gate: Promise.resolve() };
}
function connection(db = database(), faults = {}) {
  let snapshot, unlock;
  const c = {
    events: [], destroyed: false,
    async beginTransaction() {
      c.events.push(['begin']);
      if (faults.begin) throw new Error(secret);
      const previous = db.gate;
      db.gate = new Promise(resolve => { unlock = resolve; });
      await previous;
      snapshot = structuredClone(db.rows);
    },
    async commit() {
      c.events.push(['commit']);
      if (faults.commit) throw new Error(secret);
      snapshot = undefined; unlock?.(); unlock = undefined;
    },
    async rollback() {
      c.events.push(['rollback']);
      if (faults.rollback) throw new Error(secret);
      if (snapshot) db.rows = snapshot;
      snapshot = undefined; unlock?.(); unlock = undefined;
    },
    destroy() {
      assert.equal(isUploadQuotaConnectionDestroyed(c), true, '先标记再销毁');
      c.events.push(['destroy']); c.destroyed = true;
      if (snapshot) db.rows = snapshot;
      snapshot = undefined; unlock?.(); unlock = undefined;
      for (const [name, owner] of db.locks) if (owner === c) db.locks.delete(name);
      if (faults.destroy) throw new Error(secret);
    },
    async query(sql, args = []) {
      c.events.push([sql, ...args]);
      if (faults.sql && sql.includes(faults.sql)) throw new Error(secret);
      if (sql.includes('GET_LOCK')) {
        assert.equal(snapshot, undefined, '槽位锁必须早于事务');
        assert.match(sql, /, 0\)/);
        if (faults.acquireNull) return [[{ acquired: null }]];
        if (db.locks.has(args[0])) return [[{ acquired: 0 }]];
        db.locks.set(args[0], c); return [[{ acquired: 1 }]];
      }
      if (sql.includes('RELEASE_LOCK')) {
        if (faults.releaseNull) return [[{ released: null }]];
        if (faults.releaseZero) return [[{ released: 0 }]];
        assert.equal(db.locks.get(args[0]), c);
        db.locks.delete(args[0]); return [[{ released: 1 }]];
      }
      assert.ok(snapshot, '计数和日期均在事务内');
      if (sql.includes('UTC_DATE')) return [[{ period: db.day }]];
      if (sql.startsWith('INSERT IGNORE')) {
        const key = args.join('|');
        if (!db.rows.has(key)) db.rows.set(key, { attempts: 0n, bytes: 0n });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes('FOR UPDATE')) {
        const row = db.rows.get(args.join('|'));
        if (faults.missingRow) return [[]];
        return [[{ attempts: row.attempts.toString(), bytes: row.bytes.toString() }]];
      }
      if (sql.startsWith('UPDATE')) {
        const row = db.rows.get(args.slice(1).join('|'));
        row.attempts++; row.bytes += BigInt(args[0]);
        return [{ affectedRows: faults.zeroUpdate ? 0 : 1 }];
      }
      throw new Error(`未识别 SQL: ${sql}`);
    },
  };
  return c;
}
const run = (c, upload = async () => 'ok', env = {}, bytes = 1, ip = '192.0.2.1') =>
  withUploadQuota(c, ip, bytes, upload, { env });
const total = db => [...db.rows].find(([key]) => key.endsWith('|1970-01-01'))?.[1];

test('表结构、迁移常量和独立清理语句', () => {
  assert.equal(UPLOAD_QUOTA_SCHEMA_STATEMENTS.length, 1);
  const sql = UPLOAD_QUOTA_SCHEMA_STATEMENTS[0];
  for (const expression of [/scope VARCHAR\(80\) CHARACTER SET ascii/, /period DATE/, /attempts BIGINT/,
    /bytes BIGINT/, /PRIMARY KEY \(scope, period\)/, /ENGINE=InnoDB/]) assert.match(sql, expression);
  assert.match(UPLOAD_QUOTA_CLEANUP_SQL, /period <> '1970-01-01'/);
  assert.match(UPLOAD_QUOTA_CLEANUP_SQL, /UTC_DATE\(\) - INTERVAL 35 DAY/);
});

test('顺序固定、commit 早于 upload、仅保留槽位和原幂等锁，精确计量解码 bytes', async () => {
  const db = database(), c = connection(db);
  db.locks.set('submission:idempotency', c);
  const body = Buffer.from('实际内容');
  assert.equal(await run(c, async () => {
    assert.equal(c.events.at(-1)[0], 'commit');
    assert.equal(db.locks.get('nav-upload:slot:0'), c);
    return 42;
  }, {}, Buffer.from(body.toString('base64'), 'base64').byteLength), 42);
  assert.deepEqual(total(db), { attempts: 1n, bytes: BigInt(body.length) });
  const inserts = c.events.filter(([sql]) => sql.startsWith('INSERT'));
  assert.equal(inserts[0][2], '1970-01-01');
  assert.match(inserts[1][1], /^global:/); assert.match(inserts[2][1], /^ip:/);
  assert.equal(inserts[1][2], db.day); assert.equal(inserts[2][2], db.day);
  assert.deepEqual([...db.locks.keys()], ['submission:idempotency']);
  assert.equal(c.events.some(([sql]) => /DELETE|CREATE TABLE/.test(sql)), false);
});

test('所有六项配额：边界允许，超额 0 次 upload，rollback 无新增 IP 行', async () => {
  for (const name of ['OSS_UPLOAD_TOTAL_LIMIT', 'OSS_UPLOAD_DAILY_LIMIT', 'OSS_UPLOAD_IP_DAILY_LIMIT',
    'OSS_UPLOAD_TOTAL_BYTES', 'OSS_UPLOAD_DAILY_BYTES', 'OSS_UPLOAD_IP_DAILY_BYTES']) {
    const db = database(), env = { [name]: '1' };
    await run(connection(db), undefined, env);
    const before = structuredClone(db.rows), c = connection(db);
    let calls = 0;
    await assert.rejects(run(c, async () => calls++, env, 1,
      name.includes('_IP_') ? '192.0.2.1' : '198.51.100.2'), errorIs('UPLOAD_LIMIT_REACHED'));
    assert.equal(calls, 0); assert.deepEqual(db.rows, before);
    assert.ok(c.events.some(([sql]) => sql === 'rollback'));
    if (!name.includes('_IP_')) assert.equal(c.events.some(([sql, scope]) =>
      sql.startsWith('INSERT') && scope.startsWith('ip:')), false);
    assert.equal(db.locks.size, 0);
  }
});

test('默认单 IP 10 次和 5 MiB 限制', async () => {
  const db = database();
  for (let n = 0; n < 10; n++) await run(connection(db));
  await assert.rejects(run(connection(db)), errorIs('UPLOAD_LIMIT_REACHED'));
  const bytesDb = database();
  for (let n = 0; n < 5; n++) await run(connection(bytesDb), undefined, {}, MiB - 1);
  await run(connection(bytesDb), undefined, {}, 5);
  await assert.rejects(run(connection(bytesDb)), errorIs('UPLOAD_LIMIT_REACHED'));
});

test('全局两个固定并发槽，第三个忙时不开事务，上传结束后复用', async () => {
  const db = database();
  let finish0, finish1, entered0, entered1;
  const ready0 = new Promise(r => { entered0 = r; });
  const ready1 = new Promise(r => { entered1 = r; });
  const p0 = run(connection(db), () => { entered0(); return new Promise(r => { finish0 = r; }); });
  await ready0;
  const p1 = run(connection(db), () => { entered1(); return new Promise(r => { finish1 = r; }); });
  await ready1;
  assert.deepEqual([...db.locks.keys()], ['nav-upload:slot:0', 'nav-upload:slot:1']);
  const c = connection(db); let calls = 0;
  await assert.rejects(run(c, async () => calls++), errorIs('UPLOAD_BUSY'));
  assert.equal(calls, 0); assert.equal(c.events.length, 2);
  finish0(); await p0;
  await run(connection(db));
  finish1(); await p1;
  assert.equal(db.locks.size, 0); assert.equal(total(db).attempts, 3n);
});

test('独立连接争抢最后一个预算，只有一个上传', async () => {
  const db = database(); let calls = 0;
  const results = await Promise.allSettled([1, 2].map(() => run(connection(db), async () => calls++,
    { OSS_UPLOAD_TOTAL_LIMIT: '1' })));
  assert.equal(calls, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  errorIs('UPLOAD_LIMIT_REACHED')(results.find(r => r.status === 'rejected').reason);
});

test('OSS 失败或结果不明不退款，错误交给 OSS 适配器处理', async () => {
  const db = database(), failure = new Error('OSS result unknown');
  await assert.rejects(run(connection(db), async () => { throw failure; }), e => e === failure);
  assert.equal(total(db).attempts, 1n); assert.equal(db.locks.size, 0);
  await assert.rejects(run(connection(db), undefined, { OSS_UPLOAD_TOTAL_LIMIT: '1' }), errorIs('UPLOAD_LIMIT_REACHED'));
});

test('IP 规范化：IPv4 mapped、IPv6 简写/大小写、非法地址共用 unknown', () => {
  const scope = uploadQuotaIpScope;
  assert.equal(scope('192.0.2.1'), scope('::ffff:192.0.2.1'));
  assert.equal(scope('192.0.2.1'), scope('0:0:0:0:0:FFFF:c000:0201'));
  assert.equal(scope('2001:db8::1'), scope('2001:0DB8:0000:0000:0000:0000:0000:0001'));
  for (const ip of [undefined, null, '', 'bad', '1.2.3.999', '127.1', ' 192.0.2.1',
    '192.0.2.1:80', '[::1]', 'fe80::1%eth0', '192.0.2.1,192.0.2.2']) assert.equal(scope(ip), scope('unknown'));
  assert.match(scope('192.0.2.1'), /^ip:[a-f0-9]{64}$/);
  assert.notEqual(scope('192.0.2.2'), scope('192.0.2.1'));
});

test('配置 fail closed、禁用和字节边界均在 DB/OSS 前拒绝', async () => {
  const invalid = ['', '0', '-1', '1.1', '1e3', 'Infinity', 'NaN', ' 1', '01', '9007199254740992'];
  for (const name of ['OSS_UPLOAD_TOTAL_LIMIT', 'OSS_UPLOAD_DAILY_LIMIT', 'OSS_UPLOAD_IP_DAILY_LIMIT',
    'OSS_UPLOAD_TOTAL_BYTES', 'OSS_UPLOAD_DAILY_BYTES', 'OSS_UPLOAD_IP_DAILY_BYTES']) {
    for (const value of [...invalid, name.endsWith('_BYTES') ? String(1024 ** 4 + 1) : '1000001']) {
      const c = connection(); let calls = 0;
      await assert.rejects(run(c, async () => calls++, { [name]: value }), errorIs('UPLOAD_QUOTA_CONFIGURATION'));
      assert.equal(calls, 0); assert.equal(c.events.length, 0);
    }
  }
  for (const value of ['FALSE', '', 'yes', '1']) {
    await assert.rejects(run(connection(), undefined, { OSS_UPLOAD_ENABLED: value }), errorIs('UPLOAD_QUOTA_CONFIGURATION'));
  }
  const c = connection(); let calls = 0;
  await assert.rejects(run(c, async () => calls++, { OSS_UPLOAD_ENABLED: 'false', OSS_UPLOAD_TOTAL_LIMIT: 'bad' }), errorIs('UPLOAD_DISABLED'));
  assert.equal(calls, 0); assert.equal(c.events.length, 0);
  for (const size of [0, -1, 0.5, NaN, Infinity, MiB, MiB + 1, '1']) {
    await assert.rejects(run(c, async () => calls++, {}, size), errorIs('UPLOAD_QUOTA_CONFIGURATION'));
  }
  assert.equal(c.events.length, 0); assert.equal(calls, 0);
  await run(c, undefined, { OSS_UPLOAD_ENABLED: 'true' }, MiB - 1);
});

test('DB 各阶段异常脱敏，禁止 OSS；rollback 失败先标记销毁且不解锁死连接', async () => {
  for (const faults of [{ begin: true }, { sql: 'INSERT IGNORE' }, { sql: 'FOR UPDATE' },
    { sql: 'UTC_DATE' }, { sql: 'UPDATE nav_' }, { commit: true }, { missingRow: true },
    { zeroUpdate: true }, { sql: 'FOR UPDATE', rollback: true },
    { sql: 'FOR UPDATE', rollback: true, destroy: true }, { sql: 'GET_LOCK' }, { acquireNull: true }]) {
    const db = database(), c = connection(db, faults); let calls = 0;
    await assert.rejects(run(c, async () => calls++), errorIs('UPLOAD_QUOTA_UNAVAILABLE'));
    assert.equal(calls, 0); assert.equal(isUploadQuotaConnectionDestroyed(c), true);
    assert.equal(c.events.filter(([sql]) => sql === 'destroy').length, 1);
    assert.equal(c.events.some(([sql]) => sql.includes('RELEASE_LOCK')), false);
    assert.equal(db.rows.size, 0); assert.equal(db.locks.size, 0);
  }
});

test('成功上传但释放失败：503 阻止保存，预算保留，连接销毁', async () => {
  for (const faults of [{ sql: 'RELEASE_LOCK' }, { releaseNull: true }, { releaseZero: true }]) {
    const db = database(), c = connection(db, faults); let uploads = 0, saves = 0;
    await assert.rejects((async () => {
      await run(c, async () => ++uploads);
      saves++;
    })(), errorIs('UPLOAD_QUOTA_UNAVAILABLE'));
    assert.equal(uploads, 1); assert.equal(saves, 0); assert.equal(total(db).attempts, 1n);
    assert.equal(isUploadQuotaConnectionDestroyed(c), true); assert.equal(db.locks.size, 0);
    await assert.rejects(run(c), errorIs('UPLOAD_QUOTA_UNAVAILABLE'));
  }
});

test('重建模块模拟进程重启共享持久 DB，DB 日期换日而累计不清零', async () => {
  const db = database();
  const first = createUploadQuota({ env: { OSS_UPLOAD_IP_DAILY_LIMIT: '1' } });
  await first(connection(db), '192.0.2.1', 3, async () => {});
  const restarted = await import('../src/server/upload-quota.ts?simulated-process=2');
  const second = restarted.createUploadQuota({ env: { OSS_UPLOAD_IP_DAILY_LIMIT: '1' } });
  await assert.rejects(second(connection(db), '192.0.2.1', 3, async () => {}), errorIs('UPLOAD_LIMIT_REACHED'));
  db.day = '2026-09-08';
  await second(connection(db), '192.0.2.1', 5, async () => {});
  assert.deepEqual(total(db), { attempts: 2n, bytes: 8n });
  assert.equal(db.rows.size, 5);
});

test('同一连接递归调用不重入命名锁', async () => {
  const db = database(), c = connection(db);
  await run(c, async () => {
    await assert.rejects(run(c), errorIs('UPLOAD_BUSY'));
    assert.equal(db.locks.get('nav-upload:slot:0'), c);
  });
  assert.equal(total(db).attempts, 1n); assert.equal(db.locks.size, 0);
});

test('默认全局 200 次/100 MiB、累计 2000 次/1 GiB 均 fail closed', async () => {
  for (const [period, column, limit] of [
    ['daily', 'attempts', 200n], ['daily', 'bytes', 100n * BigInt(MiB)],
    ['total', 'attempts', 2000n], ['total', 'bytes', 1024n * BigInt(MiB)],
  ]) {
    const db = database(); await run(connection(db));
    const row = period === 'total' ? total(db) : [...db.rows].find(([key]) =>
      key.startsWith('global:') && !key.endsWith('|1970-01-01'))[1];
    row[column] = limit;
    const before = structuredClone(db.rows); let calls = 0;
    await assert.rejects(run(connection(db), async () => calls++, {}, 1, '198.51.100.9'), errorIs('UPLOAD_LIMIT_REACHED'));
    assert.equal(calls, 0); assert.deepEqual(db.rows, before);
  }
});

test('超过剩余字节预算不能部分收费或创建新 IP 行', async () => {
  const db = database(); await run(connection(db));
  const before = structuredClone(db.rows); let calls = 0;
  await assert.rejects(run(connection(db), async () => calls++, { OSS_UPLOAD_DAILY_BYTES: '2' }, 2,
    '198.51.100.8'), errorIs('UPLOAD_LIMIT_REACHED'));
  assert.equal(calls, 0); assert.deepEqual(db.rows, before);
});

test('commit 已落盘但应答丢失：不上传、不退款、销毁连接并脱敏', async () => {
  const db = database(), c = connection(db);
  const commit = c.commit;
  c.commit = async () => { await commit(); throw new Error(secret); };
  let calls = 0;
  await assert.rejects(run(c, async () => calls++), errorIs('UPLOAD_QUOTA_UNAVAILABLE'));
  assert.equal(calls, 0); assert.deepEqual(total(db), { attempts: 1n, bytes: 1n });
  assert.equal(isUploadQuotaConnectionDestroyed(c), true);
});

test('事务跨 DB UTC 午夜：本次两个 daily 桶仍使用同一天', async () => {
  const db = database(), c = connection(db), query = c.query;
  c.query = async (sql, args) => {
    const result = await query(sql, args);
    if (sql.includes('UTC_DATE')) db.day = '2026-09-08';
    return result;
  };
  await run(c);
  assert.equal([...db.rows.keys()].filter(key => key.endsWith('|2026-09-07')).length, 2);
  await run(connection(db));
  assert.equal([...db.rows.keys()].filter(key => key.endsWith('|2026-09-08')).length, 2);
});

test('真实新 Node 子进程从持久化 fake DB 读取额度，不依赖进程内计数或应用日期', async () => {
  const { spawnSync } = await import('node:child_process');
  const db = database();
  await run(connection(db), undefined, {}, 7);
  const moduleUrl = new URL('../src/server/upload-quota.ts', import.meta.url).href;
  const source = `
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { withUploadQuota, isUploadQuotaConnectionDestroyed } from ${JSON.stringify(moduleUrl)};
    const secret = 'private';
    ${database.toString()}
    ${connection.toString()}
    const db = database();
    const persisted = JSON.parse(readFileSync(0, 'utf8'));
    db.rows = new Map(persisted.map(([key, row]) => [key, {
      attempts: BigInt(row.attempts), bytes: BigInt(row.bytes)
    }]));
    Date.now = () => { throw new Error('禁止读取应用时钟'); };
    let uploads = 0, code;
    const invoke = () => withUploadQuota(connection(db), '192.0.2.1', 5,
      async () => ++uploads, { env: { OSS_UPLOAD_IP_DAILY_LIMIT: '1' } });
    try { await invoke(); } catch (error) { code = error.code; }
    db.day = '2026-09-08';
    await invoke();
    console.log(JSON.stringify({ code, uploads, rows: [...db.rows] },
      (_, value) => typeof value === 'bigint' ? value.toString() : value));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    input: JSON.stringify([...db.rows], (_, value) => typeof value === 'bigint' ? value.toString() : value),
    encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const persisted = JSON.parse(result.stdout);
  assert.equal(persisted.code, 'UPLOAD_LIMIT_REACHED'); assert.equal(persisted.uploads, 1);
  assert.deepEqual(persisted.rows.find(([key]) => key.endsWith('|1970-01-01'))[1],
    { attempts: '2', bytes: '12' });
  assert.equal(persisted.rows.length, 5);
});
