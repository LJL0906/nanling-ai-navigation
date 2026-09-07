import test from 'node:test';
import assert from 'node:assert/strict';
import { createPersonalStore, PERSONAL_KEYS, HISTORY_LIMIT } from '../src/lib/personal-store.ts';

function setup() {
  const values = new Map();
  let tick = 0;
  const store = createPersonalStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    () => new Date(Date.UTC(2026, 8, 7, 0, 0, tick++)).toISOString());
  return { values, store };
}
test('初次使用收藏和历史均为空', () => {
  const { store } = setup();
  assert.deepEqual(store.read('favorites'), []);
  assert.deepEqual(store.read('history'), []);
});
test('收藏切换、取消再收藏、最新优先且不重复', () => {
  const { store } = setup();
  assert.equal(store.toggleFavorite('site_a'), true);
  store.toggleFavorite('site_b');
  assert.deepEqual(store.read('favorites').map((item) => item.siteId), ['site_b', 'site_a']);
  assert.equal(store.toggleFavorite('site_a'), false);
  assert.equal(store.toggleFavorite('site_a'), true);
  assert.deepEqual(store.read('favorites').map((item) => item.siteId), ['site_a', 'site_b']);
});
test('存储仅保存ID和时间，不保存网址和完整站点信息', () => {
  const { store, values } = setup();
  store.toggleFavorite('site_a');
  assert.deepEqual(Object.keys(JSON.parse(values.get(PERSONAL_KEYS.favorites))[0]), ['siteId', 'updatedAt']);
});
test('刷新或新实例能恢复收藏与历史', () => {
  const { store, values } = setup();
  store.toggleFavorite('site_a');
  store.recordVisit('site_b', 'external');
  const fresh = createPersonalStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  assert.deepEqual(fresh.read('favorites'), store.read('favorites'));
  assert.deepEqual(fresh.read('history'), store.read('history'));
});
test('浏览详情和点击官网共用站点ID，最新访问置顶', () => {
  const { store } = setup();
  store.recordVisit('site_a', 'detail');
  store.recordVisit('site_b', 'external');
  store.recordVisit('site_a', 'external');
  assert.deepEqual(store.read('history').map((item) => item.siteId), ['site_a', 'site_b']);
  assert.equal(store.read('history')[0].visitType, 'external');
});
test('访问历史最多100条，丢弃最旧记录', () => {
  const { store } = setup();
  for (let i = 0; i < 105; i++) store.recordVisit(`site_${i}`, 'external');
  const items = store.read('history');
  assert.equal(items.length, HISTORY_LIMIT);
  assert.equal(items[0].siteId, 'site_104');
  assert.equal(items.at(-1).siteId, 'site_5');
});
test('移除与清空分别只影响目标列表', () => {
  const { store } = setup();
  store.toggleFavorite('site_a');
  store.recordVisit('site_a', 'detail');
  store.remove('history', 'site_a');
  assert.equal(store.read('history').length, 0);
  assert.equal(store.read('favorites').length, 1);
  store.recordVisit('site_a', 'external');
  store.clear('favorites');
  assert.equal(store.read('favorites').length, 0);
  assert.equal(store.read('history').length, 1);
  store.clear('history');
  assert.equal(store.read('history').length, 0);
});
test('损坏JSON、不正确结构和非法记录安全兜底', () => {
  const { store, values } = setup();
  for (const raw of ['{', '{}', 'null', '42', '"text"']) {
    values.set(PERSONAL_KEYS.favorites, raw);
    assert.deepEqual(store.read('favorites'), []);
  }
  values.set(PERSONAL_KEYS.favorites, JSON.stringify([null, 42, {}, { siteId: '../bad', updatedAt: '2026-09-07' }, { siteId: 'site_a', updatedAt: 'invalid' }]));
  assert.deepEqual(store.read('favorites'), []);
});
test('存储重复项保留最新记录，非法visitType被忽略', () => {
  const { store, values } = setup();
  values.set(PERSONAL_KEYS.history, JSON.stringify([
    { siteId: 'site_a', updatedAt: '2026-09-06', visitType: 'detail' },
    { siteId: 'site_a', updatedAt: '2026-09-07', visitType: 'invalid' },
  ]));
  assert.deepEqual(store.read('history'), [{ siteId: 'site_a', updatedAt: '2026-09-07' }]);
});
test('浏览器读取受限时不覆盖已有记录', () => {
  let writes = 0;
  const store = createPersonalStore({ getItem() { throw new Error('denied'); }, setItem() { writes++; } });
  assert.throws(() => store.read('favorites'));
  assert.throws(() => store.toggleFavorite('site_a'));
  assert.throws(() => store.recordVisit('site_a', 'detail'));
  assert.equal(writes, 0);
});
test('容量不足或写入失败时向UI报告失败', () => {
  const store = createPersonalStore({ getItem: () => null, setItem() { throw new Error('quota'); } });
  assert.throws(() => store.toggleFavorite('site_a'), /quota/);
  assert.throws(() => store.clear('history'), /quota/);
});
test('拒绝非法站点ID', () => {
  const { store } = setup();
  for (const id of ['', 'chatgpt', '../site_a', null]) {
    assert.throws(() => store.toggleFavorite(id));
    assert.throws(() => store.recordVisit(id, 'detail'));
  }
});
test('每次操作重新读取存储，接收其他标签页已经写入的数据', () => {
  const { store, values } = setup();
  store.toggleFavorite('site_a');
  const other = createPersonalStore({ getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  other.toggleFavorite('site_b');
  store.toggleFavorite('site_c');
  assert.deepEqual(new Set(store.read('favorites').map((item) => item.siteId)), new Set(['site_a', 'site_b', 'site_c']));
});
