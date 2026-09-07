import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createNavigationCache } from '../src/server/navigation-cache.ts';
import { menuRevision, validateMenus, visibleMenus } from '../src/server/menu-validation.ts';
import { HttpError } from '../src/server/http.ts';

const menu = (label = '菜单') => ({ id: 'a', parentId: null, location: 'topbar', kind: 'link',
  label, href: '/tools/', icon: 'lucide:house', sortOrder: 0, enabled: true, payload: {} });
const snapshot = (label = '菜单') => {
  const menus = [menu(label)];
  return { menus, revision: menuRevision(menus), writable: true };
};
const source = stripTypeScriptTypes(readFileSync(new URL('../src/server/menus.ts', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
// 执行完整 menus.ts；仅替换数据库边界与种子来源，不连接 MySQL、不读 .env。
function setup({ read, save, driver = 'mysql' } = {}) {
  const calls = { reads: 0, saves: [], seeds: 0 };
  const api = runInNewContext(`${source}\n({ getMenuSnapshot, getPublicMenus, saveMenus });`, {
    createNavigationCache, HttpError, menuRevision, validateMenus, visibleMenus,
    getStorageDriver: () => driver,
    buildMenuSeed: () => { calls.seeds++; return { menus: [menu()] }; },
    readMysqlMenus: () => { calls.reads++; return read?.(calls.reads) ?? Promise.resolve(snapshot()); },
    saveMysqlMenus: async (menus, revision) => {
      calls.saves.push({ menus, revision });
      return save ? save(menus, revision) : snapshot('新菜单');
    },
  });
  return { ...api, calls };
}

test('5 个并发菜单读取只调用一次，完成后下一批重新读库', async () => {
  const gates = [Promise.withResolvers(), Promise.withResolvers()];
  const ctx = setup({ read: n => gates[n - 1].promise });
  for (let batch = 0; batch < 2; batch++) {
    const requests = Array.from({ length: 5 }, () => ctx.getMenuSnapshot());
    await Promise.resolve();
    assert.equal(ctx.calls.reads, batch + 1);
    const value = snapshot(`批次${batch}`);
    gates[batch].resolve(value);
    const results = await Promise.all(requests);
    assert.ok(results.every(result => result === value));
  }
});

test('公开菜单与管理快照共享在途读取，保留可见性过滤', async () => {
  const gate = Promise.withResolvers();
  const ctx = setup({ read: () => gate.promise });
  const admin = ctx.getMenuSnapshot();
  const publicMenus = ctx.getPublicMenus();
  const value = snapshot();
  value.menus.push({ ...menu('隐藏'), id: 'hidden', enabled: false });
  gate.resolve(value);
  assert.strictEqual(await admin, value);
  assert.deepEqual(await publicMenus, visibleMenus(value.menus));
  assert.equal(ctx.calls.reads, 1);
});

test('并发读取失败原样传播，下一次请求重试且不回退种子', async () => {
  const gate = Promise.withResolvers();
  const error = new HttpError(503, 'MENU_DATABASE_UNAVAILABLE', '读取失败');
  const ctx = setup({ read: n => n === 1 ? gate.promise : Promise.resolve(snapshot('恢复')) });
  const results = Promise.allSettled(Array.from({ length: 5 }, () => ctx.getMenuSnapshot()));
  gate.reject(error);
  assert.ok((await results).every(result => result.status === 'rejected' && result.reason === error));
  assert.equal(ctx.calls.reads, 1);
  assert.equal((await ctx.getMenuSnapshot()).menus[0].label, '恢复');
  assert.equal(ctx.calls.reads, 2);
  assert.equal(ctx.calls.seeds, 0);
});

for (const oldFails of [false, true]) {
  test(`保存成功后不复用旧读，旧读${oldFails ? '失败' : '成功'}不清除新批次`, async () => {
    const old = Promise.withResolvers();
    const fresh = Promise.withResolvers();
    const commit = Promise.withResolvers();
    const ctx = setup({ read: n => n === 1 ? old.promise : fresh.promise, save: () => commit.promise });
    const first = ctx.getMenuSnapshot();
    const saving = ctx.saveMenus([menu('新菜单')], snapshot().revision);
    const beforeCommit = ctx.getMenuSnapshot();
    const oldResults = Promise.allSettled([first, beforeCommit]);
    await Promise.resolve();
    assert.equal(ctx.calls.reads, 1);
    const saved = snapshot('新菜单');
    commit.resolve(saved);
    assert.strictEqual(await saving, saved);
    const next = ctx.getMenuSnapshot();
    await Promise.resolve();
    assert.equal(ctx.calls.reads, 2);
    if (oldFails) old.reject(new Error('旧读失败')); else old.resolve(snapshot('旧菜单'));
    const previous = await oldResults;
    assert.ok(previous.every(result => result.status === (oldFails ? 'rejected' : 'fulfilled')));
    const joined = ctx.getMenuSnapshot();
    await Promise.resolve();
    assert.equal(ctx.calls.reads, 2);
    fresh.resolve(saved);
    assert.strictEqual(await next, saved);
    assert.strictEqual(await joined, saved);
  });
}

test('保存失败及版本冲突原样传播，不断开现有在途读取', async () => {
  for (const error of [new Error('保存失败'), new HttpError(409, 'MENU_CONFLICT', '版本冲突')]) {
    const gate = Promise.withResolvers();
    const ctx = setup({ read: () => gate.promise, save: async () => { throw error; } });
    const first = ctx.getMenuSnapshot();
    await assert.rejects(ctx.saveMenus([menu()], snapshot().revision), e => e === error);
    const second = ctx.getMenuSnapshot();
    await Promise.resolve();
    assert.equal(ctx.calls.reads, 1);
    gate.resolve(snapshot());
    assert.strictEqual(await first, await second);
  }
});

test('保存仍校验菜单和 revision，合法版本原样交给事务仓储', async () => {
  const ctx = setup();
  await assert.rejects(ctx.saveMenus([menu()], 'bad'), { code: 'INVALID_MENU_REVISION' });
  await assert.rejects(ctx.saveMenus([], snapshot().revision), { code: 'INVALID_MENU' });
  assert.equal(ctx.calls.saves.length, 0);
  const value = [menu('已更新')];
  const revision = snapshot().revision;
  await ctx.saveMenus(value, revision);
  assert.equal(ctx.calls.saves[0].revision, revision);
  assert.deepEqual(ctx.calls.saves[0].menus, validateMenus(value));
  assert.notStrictEqual(ctx.calls.saves[0].menus, value);
});

test('seed 保持每次构建和只读语义，不进入 MySQL 合并层', async () => {
  const ctx = setup({ driver: 'seed' });
  const results = await Promise.all(Array.from({ length: 5 }, () => ctx.getMenuSnapshot()));
  assert.equal(ctx.calls.seeds, 5);
  assert.equal(ctx.calls.reads, 0);
  assert.ok(results.every(result => result.writable === false && result.revision === menuRevision(result.menus)));
  await assert.rejects(ctx.saveMenus([menu()], snapshot().revision), { code: 'MENU_READ_ONLY' });
  assert.equal(ctx.calls.saves.length, 0);
});
