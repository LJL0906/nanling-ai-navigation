import test from 'node:test';
import assert from 'node:assert/strict';
import { writeMenuTransaction, decodeMenuRows } from '../src/server/menu-store.ts';
import { validateMenus, menuRevision } from '../src/server/menu-validation.ts';
import { HttpError } from '../src/server/http.ts';

const menu = (patch = {}) => ({ id: 'a', parentId: null, location: 'topbar', kind: 'link',
  label: '菜单', href: '/tools/', icon: null, sortOrder: 0, enabled: true, payload: {}, ...patch });
const rowsOf = menus => menus.map(m => ({ id: m.id, parent_id: m.parentId, location: m.location, kind: m.kind,
  label: m.label, href: m.href, icon: m.icon, sort_order: m.sortOrder, enabled: Number(m.enabled), payload: JSON.stringify(m.payload) }));
const errorIs = (status, code) => error => error instanceof HttpError && error.status === status && error.code === code;

// 严格白名单 fake：未知SQL直接失败，模拟事务状态和参数化写入，不创建真实Pool。
function fakeConnection(current = [menu()], options = {}) {
  let rows = rowsOf(current);
  let backup;
  const calls = [];
  const invoke = (method, sql, params) => {
    calls.push({ method, sql, params: structuredClone(params) });
    if (options.fail?.(sql)) throw options.failure ?? new Error('injected database failure');
  };
  const connection = {
    calls,
    rows: () => structuredClone(rows),
    async execute(sql, params) {
      invoke('execute', sql, params);
      assert.ok(Array.isArray(params), 'execute 必须使用绑定参数');
      if (sql.startsWith('SELECT GET_LOCK')) {
        assert.deepEqual(params, ['nanling_menu_initial_import']);
        return [[{ acquired: options.lock === undefined ? 1 : options.lock }]];
      }
      if (sql.startsWith('SELECT RELEASE_LOCK')) {
        assert.deepEqual(params, ['nanling_menu_initial_import']);
        return [[{ released: options.release === undefined ? 1 : options.release }]];
      }
      assert.ok(backup, 'DML 必须在事务内');
      if (sql === 'DELETE FROM nav_menus WHERE id = ?') {
        assert.equal(params.length, 1);
        rows = rows.filter(row => row.id !== params[0]);
      } else if (sql.startsWith('INSERT INTO nav_menus ')) {
        assert.match(sql, /VALUES \(\?,NULL,\?,\?,\?,\?,\?,\?,\?,\?\) ON DUPLICATE KEY UPDATE/);
        assert.equal(params.length, 9);
        const [id, location, kind, label, href, icon, sort_order, enabled, payload] = params;
        const row = { id, parent_id: null, location, kind, label, href, icon, sort_order, enabled, payload };
        const index = rows.findIndex(r => r.id === id);
        if (index < 0) rows.push(row); else rows[index] = row;
      } else if (sql === 'UPDATE nav_menus SET parent_id = ? WHERE id = ?') {
        assert.equal(params.length, 2);
        assert.ok(rows.some(r => r.id === params[0]), '先插入父级，再恢复引用');
        const child = rows.find(r => r.id === params[1]);
        assert.ok(child);
        child.parent_id = params[0];
      } else assert.fail(`未预期的execute: ${sql}`);
      return [{ affectedRows: 1 }];
    },
    async query(sql) {
      invoke('query', sql);
      if (sql.startsWith('SELECT ENGINE AS engine FROM information_schema.TABLES'))
        return [options.tables ?? [{ engine: 'InnoDB' }]];
      if (sql === 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') return [{}];
      assert.ok(backup, '菜单读写必须在事务内');
      if (sql === 'SELECT * FROM nav_menus FOR UPDATE') return [structuredClone(rows)];
      if (sql === 'SELECT slug FROM nav_categories') return [(options.categories ?? ['ai']).map(slug => ({ slug }))];
      if (sql === 'UPDATE nav_menus SET parent_id = NULL WHERE parent_id IS NOT NULL') {
        rows.forEach(row => { row.parent_id = null; });
        return [{ affectedRows: rows.length }];
      }
      if (sql === 'SELECT * FROM nav_menus') return [options.readback ?? structuredClone(rows)];
      assert.fail(`未预期的query: ${sql}`);
    },
    async beginTransaction() { invoke('begin', 'BEGIN'); backup = structuredClone(rows); },
    async commit() { invoke('commit', 'COMMIT'); assert.ok(backup); backup = undefined; },
    async rollback() {
      invoke('rollback', 'ROLLBACK');
      assert.ok(backup);
      rows = backup;
      backup = undefined;
    },
    release() { assert.fail('连接归还属于withConnection，writeMenuTransaction不可提前归还'); },
  };
  return connection;
}
const sqls = connection => connection.calls.map(c => c.sql);
const noWrites = connection => assert.ok(!sqls(connection).some(sql => /^(INSERT|UPDATE|DELETE)/.test(sql)));
const released = connection => assert.match(sqls(connection).at(-1), /^SELECT RELEASE_LOCK/);

test('版本冲突409：加锁和FOR UPDATE后比较版本，回滚释放且不写入', async () => {
  const connection = fakeConnection();
  await assert.rejects(writeMenuTransaction(connection, [menu({ label: '新菜单' })], '0'.repeat(64)), errorIs(409, 'MENU_CONFLICT'));
  noWrites(connection);
  assert.ok(sqls(connection).indexOf('SELECT * FROM nav_menus FOR UPDATE') > sqls(connection).indexOf('BEGIN'));
  assert.ok(sqls(connection).includes('ROLLBACK'));
  assert.ok(!sqls(connection).includes('COMMIT'));
  assert.ok(!sqls(connection).includes('SELECT slug FROM nav_categories'));
  released(connection);
});

for (const lock of [0, null]) test(`拿锁失败 ${lock} 返回409且不开始事务或释放别人的锁`, async () => {
  const connection = fakeConnection(undefined, { lock });
  await assert.rejects(writeMenuTransaction(connection, [menu()], menuRevision([menu()])), errorIs(409, 'MENU_BUSY'));
  assert.equal(connection.calls.length, 1);
});

for (const tables of [[{ engine: 'MyISAM' }], [], [{ engine: 'InnoDB' }, { engine: 'InnoDB' }]])
  test(`拒绝非单一InnoDB菜单表 ${JSON.stringify(tables)}`, async () => {
    const connection = fakeConnection(undefined, { tables });
    await assert.rejects(writeMenuTransaction(connection, [menu()], menuRevision([menu()])), errorIs(503, 'MENU_SCHEMA_INVALID'));
    noWrites(connection);
    assert.ok(!sqls(connection).includes('BEGIN'));
    assert.ok(!sqls(connection).includes('ROLLBACK'));
    released(connection);
  });

test('无变更仅提交快照，不执行DML，仍验证分类引用并释放锁', async () => {
  const current = [menu()];
  const connection = fakeConnection(current);
  const result = await writeMenuTransaction(connection, current, menuRevision(current));
  assert.deepEqual(result, { menus: validateMenus(current), revision: menuRevision(current), writable: true });
  noWrites(connection);
  assert.ok(sqls(connection).includes('SELECT slug FROM nav_categories'));
  assert.ok(sqls(connection).includes('COMMIT'));
  assert.ok(!sqls(connection).includes('ROLLBACK'));
  released(connection);
});

test('参数化事务执行删除、新增、修改、移动父级并回读一致快照', async () => {
  const current = validateMenus([menu({ id: 'old-group', kind: 'group', href: null }),
    menu({ parentId: 'old-group' }), menu({ id: 'removed' })]);
  const label = "O'Reilly'); DROP TABLE nav_menus; --";
  const desired = validateMenus([menu({ id: 'new-group', kind: 'group', href: null }),
    menu({ parentId: 'new-group', kind: 'resource', label, enabled: false, sortOrder: 12,
      payload: { target: '_blank', description: '含单引号\'和中文' } }), menu({ id: 'new-link', href: 'https://example.test/' })]);
  const connection = fakeConnection(current);
  const result = await writeMenuTransaction(connection, desired, menuRevision(current));
  assert.deepEqual(result, { menus: desired, revision: menuRevision(desired), writable: true });
  assert.deepEqual(decodeMenuRows(connection.rows()), desired);
  const calls = connection.calls;
  assert.ok(calls.every(c => !c.sql.includes(label) && !c.sql.includes('FOREIGN_KEY_CHECKS')));
  assert.deepEqual(calls.filter(c => c.sql.startsWith('DELETE')).map(c => c.params[0]).sort(), ['old-group', 'removed']);
  const inserts = calls.filter(c => c.sql.startsWith('INSERT'));
  assert.equal(inserts.length, desired.length);
  const child = inserts.find(c => c.params[0] === 'a');
  assert.equal(child.params[3], label);
  assert.equal(child.params[7], 0);
  assert.deepEqual(JSON.parse(child.params[8]), desired.find(m => m.id === 'a').payload);
  const operations = sqls(connection);
  assert.ok(operations.indexOf('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ') < operations.indexOf('BEGIN'));
  assert.ok(operations.indexOf('UPDATE nav_menus SET parent_id = NULL WHERE parent_id IS NOT NULL') < operations.findIndex(s => s.startsWith('DELETE')));
  assert.ok(operations.indexOf('UPDATE nav_menus SET parent_id = ? WHERE id = ?') > operations.findLastIndex(s => s.startsWith('INSERT')));
  assert.ok(operations.indexOf('COMMIT') > operations.indexOf('SELECT * FROM nav_menus'));
  assert.ok(!operations.includes('ROLLBACK'));
  released(connection);
});

test('分类引用必须存在：含有效分类可提交，未知分类在任何写入之前拒绝', async () => {
  const current = [menu()];
  const desired = validateMenus([menu({ kind: 'category', location: 'sidebar', href: '/#ai', payload: { homeAnchor: 'ai', categoryPath: '/ai/' } })]);
  const good = fakeConnection(current);
  assert.deepEqual((await writeMenuTransaction(good, desired, menuRevision(current))).menus, desired);
  for (const initial of [current, desired]) {
    const connection = fakeConnection(initial, { categories: [] });
    await assert.rejects(writeMenuTransaction(connection, desired, menuRevision(initial)), errorIs(400, 'INVALID_MENU_CATEGORY'));
    noWrites(connection);
    assert.ok(sqls(connection).includes('ROLLBACK'));
    released(connection);
  }
});

for (const stage of ['SELECT slug', 'UPDATE nav_menus SET parent_id = NULL', 'DELETE', 'INSERT', 'UPDATE nav_menus SET parent_id = ?', 'SELECT * FROM nav_menus', 'COMMIT'])
  test(`事务异常 ${stage} 回滚原数据并释放锁`, async () => {
    const current = [menu({ id: 'removed' })];
    const desired = validateMenus([menu({ id: 'g', kind: 'group', href: null }), menu({ parentId: 'g' })]);
    const failure = new Error(`模拟异常 ${stage}`);
    const connection = fakeConnection(current, { failure, fail: sql => stage === 'SELECT * FROM nav_menus' ? sql === stage : sql.startsWith(stage) });
    await assert.rejects(writeMenuTransaction(connection, desired, menuRevision(current)), error => error === failure);
    assert.deepEqual(connection.rows(), rowsOf(current));
    assert.equal(sqls(connection).filter(sql => sql === 'ROLLBACK').length, 1);
    released(connection);
  });

test('回读与目标不一致或损坏时拒绝提交并回滚', async () => {
  for (const [readback, code] of [[rowsOf([menu()]), 'MENU_SAVE_MISMATCH'], [[], 'MENU_DATA_INVALID'],
    [[{ ...rowsOf([menu()])[0], payload: '{bad' }], 'MENU_DATA_INVALID']]) {
    const connection = fakeConnection(undefined, { readback });
    await assert.rejects(writeMenuTransaction(connection, [menu({ label: '新名称' })], menuRevision([menu()])), errorIs(503, code));
    assert.ok(sqls(connection).includes('ROLLBACK'));
    assert.ok(!sqls(connection).includes('COMMIT'));
    assert.deepEqual(connection.rows(), rowsOf([menu()]));
    released(connection);
  }
});

test('回滚自身失败仍尝试释放命名锁', async () => {
  const failure = new Error('rollback failed');
  const connection = fakeConnection(undefined, { fail: sql => sql === 'ROLLBACK', failure });
  await assert.rejects(writeMenuTransaction(connection, [menu()], '0'.repeat(64)), error => error === failure);
  released(connection);
});

test('BEGIN失败仍释放锁但不错误回滚未开始的事务', async () => {
  const failure = new Error('begin failed');
  const connection = fakeConnection(undefined, { fail: sql => sql === 'BEGIN', failure });
  await assert.rejects(writeMenuTransaction(connection, [menu()], menuRevision([menu()])), error => error === failure);
  assert.ok(!sqls(connection).includes('ROLLBACK'));
  released(connection);
});

test('锁释放失败返回503且不回滚已提交的事务', async () => {
  const connection = fakeConnection(undefined, { release: 0 });
  await assert.rejects(writeMenuTransaction(connection, [menu()], menuRevision([menu()])), errorIs(503, 'MENU_LOCK_RELEASE_FAILED'));
  assert.ok(sqls(connection).includes('COMMIT'));
  assert.ok(!sqls(connection).includes('ROLLBACK'));
  released(connection);
});

test('decodeMenuRows 接受字符串/对象JSON与布尔enabled，损坏数据返回503', () => {
  const rows = rowsOf([menu()]);
  assert.deepEqual(decodeMenuRows(rows), [menu()]);
  assert.deepEqual(decodeMenuRows([{ ...rows[0], payload: {}, enabled: true }]), [menu()]);
  for (const bad of [[], [{ ...rows[0], payload: '{bad' }], [{ ...rows[0], href: 'javascript:alert(1)' }]])
    assert.throws(() => decodeMenuRows(bad), errorIs(503, 'MENU_DATA_INVALID'));
});

test('decodeMenuRows 拒绝损坏的 enabled，而非静默转为隐藏', () => {
  for (const enabled of [null, 2, -1, 'true', '0']) {
    assert.throws(() => decodeMenuRows([{ ...rowsOf([menu()])[0], enabled }]), errorIs(503, 'MENU_DATA_INVALID'));
  }
});
