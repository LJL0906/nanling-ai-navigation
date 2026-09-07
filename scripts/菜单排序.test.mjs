import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MENU_ORDER_KEY,
  normalizeMenuOrder,
  readMenuOrder,
  saveMenuOrder,
} from '../src/lib/menu-order.ts';

const defaultIds = Object.freeze(['home', 'tools', 'about']);

function storageWith(value) {
  return {
    getItem(key) {
      assert.equal(key, 'nav:menu-order:v1');
      return value;
    },
  };
}

test('存储键使用约定版本', () => {
  assert.equal(MENU_ORDER_KEY, 'nav:menu-order:v1');
});

test('保留有效已保存顺序且不修改输入', () => {
  const saved = Object.freeze(['about', 'home', 'tools']);
  const result = normalizeMenuOrder(defaultIds, saved);
  assert.deepEqual(result, ['about', 'home', 'tools']);
  assert.notStrictEqual(result, saved);
  assert.deepEqual(defaultIds, ['home', 'tools', 'about']);
});

test('过滤非法值和未知 ID，去重并保留首次出现顺序', () => {
  assert.deepEqual(
    normalizeMenuOrder(defaultIds, [
      'tools', null, 1, false, {}, ['home'], '', 'deleted',
      'tools', 'home', 'home', 'about',
    ]),
    ['tools', 'home', 'about'],
  );
});

test('默认 ID 也去重，空保存顺序回到默认', () => {
  assert.deepEqual(
    normalizeMenuOrder(['home', 'tools', 'home', 'about', 'tools'], []),
    ['home', 'tools', 'about'],
  );
});

test('非数组保存值安全回到默认且返回新数组', () => {
  for (const saved of [undefined, null, true, 42, 'tools', {}, { 0: 'tools' }]) {
    const result = normalizeMenuOrder(defaultIds, saved);
    assert.deepEqual(result, defaultIds);
    assert.notStrictEqual(result, defaultIds);
  }
});

test('删除的菜单被移除，新增菜单按默认顺序追加末尾', () => {
  assert.deepEqual(
    normalizeMenuOrder(
      ['home', 'tools', 'new-first', 'about', 'new-second'],
      ['about', 'deleted', 'tools'],
    ),
    ['about', 'tools', 'home', 'new-first', 'new-second'],
  );
});

test('空默认菜单不会恢复旧菜单', () => {
  assert.deepEqual(normalizeMenuOrder([], ['home', 'tools']), []);
  assert.deepEqual(normalizeMenuOrder([], null), []);
});

test('读取 JSON 并规范化已保存排序', () => {
  const storage = storageWith('["about","deleted",null,"about","tools"]');
  assert.deepEqual(readMenuOrder(storage, defaultIds), ['about', 'tools', 'home']);
});

test('缺失、损坏 JSON 或非法 JSON 结构回到默认', () => {
  for (const value of [null, '', '{broken', '["tools",', 'null', '{}', '1', 'true', '"tools"']) {
    assert.deepEqual(readMenuOrder(storageWith(value), defaultIds), defaultIds);
  }
});

test('读取异常安全回到默认并去重', () => {
  const storage = {
    getItem() {
      throw new Error('访问存储被拒绝');
    },
  };
  assert.deepEqual(readMenuOrder(storage, defaultIds), defaultIds);
  assert.deepEqual(readMenuOrder(storage, ['home', 'home']), ['home']);
});

test('成功写入约定键与 JSON，返回 true 且不修改输入', () => {
  const ids = Object.freeze(['about', 'tools', 'home']);
  const writes = [];
  const storage = {
    setItem(key, value) {
      writes.push([key, value]);
    },
  };
  assert.equal(saveMenuOrder(storage, ids), true);
  assert.deepEqual(writes, [['nav:menu-order:v1', '["about","tools","home"]']]);
  assert.deepEqual(ids, ['about', 'tools', 'home']);
});

test('空顺序写入空 JSON 数组并可读取', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(saveMenuOrder(storage, []), true);
  assert.equal(values.get(MENU_ORDER_KEY), '[]');
  assert.deepEqual(readMenuOrder(storage, []), []);
  assert.deepEqual(readMenuOrder(storage, defaultIds), defaultIds);
});

test('保存后读取可还原排序', () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const ids = ['tools', 'about', 'home'];
  assert.equal(saveMenuOrder(storage, ids), true);
  assert.deepEqual(readMenuOrder(storage, defaultIds), ids);
});

test('写入异常返回 false 而不向外抛出', () => {
  const storage = {
    setItem() {
      throw new Error('存储配额不足');
    },
  };
  assert.equal(saveMenuOrder(storage, defaultIds), false);
});


test('已有记录中的首页始终置顶，其余分类顺序保留', () => {
  const ids = ['/', '/ai/', '/dev/', '/categories/'];
  assert.deepEqual(normalizeMenuOrder(ids, ['/dev/', '/categories/', '/', '/ai/']),
    ['/', '/dev/', '/categories/', '/ai/']);
  assert.deepEqual(normalizeMenuOrder(ids, ['/dev/', '/ai/']),
    ['/', '/dev/', '/ai/', '/categories/']);
});
