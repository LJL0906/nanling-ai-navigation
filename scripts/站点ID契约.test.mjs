import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { isValidSiteId } from '../src/lib/site-id.ts';
import { adaptNavigation } from '../src/lib/adapt-navigation.ts';
import { createPersonalStore, PERSONAL_KEYS } from '../src/lib/personal-store.ts';
import { createPersonalApi } from '../src/scripts/personal-api.ts';
import { validatePersonalAction } from '../src/server/personal-validation.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const valid = ['site_Ab09', `site_${'a'.repeat(59)}`, `site-${randomUUID()}`, `submitted-${randomUUID()}`,
  'site-550E8400-E29B-41D4-A716-446655440000'];
const invalid = [null, undefined, 123, {}, ['site_a'], '', 'anything', 'site_', 'site_a-b',
  `site_${'a'.repeat(60)}`, 'site-not-a-uuid', 'submitted-abc', 'submitted_abc',
  'site-550e8400e29b41d4a716446655440000', 'site-550e8400-e29b-01d4-a716-446655440000',
  'submitted-550e8400-e29b-41d4-7716-446655440000', 'site-550e8400-e29b-41d4-a716-44665544000g',
  ...valid.flatMap((id) => [` ${id}`, `${id} `, `${id}\n`, `${id}\r`, `${id}/`, `${id}\0`])];
const stamp = '2026-09-07T00:00:00.000Z';
const record = (siteId) => ({ siteId, updatedAt: stamp });
function runtime(path, names, extra = {}) {
  const code = stripTypeScriptTypes(read(path)).replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  return runInNewContext(`${code}\n;({${names.join(',')}})`, {
    isValidSiteId, URL, document: { querySelector: () => null, addEventListener() {} },
    window: { addEventListener() {} }, ...extra,
  });
}
const { prepareIndex, findMatches, paginate } = runtime('src/scripts/search.ts', ['prepareIndex', 'findMatches', 'paginate']);
const { categories } = adaptNavigation(JSON.parse(read('src/data/导航数据.json')), JSON.parse(read('src/data/sites.json')));
const sites = categories.flatMap((category, index) => category.sites.map((site) => ({ ...site, categoryName: category.name, category: index, terms: site.tags.join(' ') })));
const index = (extra) => ({ version: 1, categories, sites: [...sites, ...extra.map((id) => ({ ...sites[0], id }))] });
function storage(seed = []) {
  const values = new Map([[PERSONAL_KEYS.favorites, JSON.stringify(seed)]]);
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

test('站点ID契约接受真实生成格式与64字符边界，拒绝任意字符串及畸形UUID', () => {
  for (const id of valid) assert.equal(isValidSiteId(id), true, String(id));
  for (const id of invalid) assert.equal(isValidSiteId(id), false, String(id));
});
test('搜索全量目录混合新增和审核站点后全部可检索、分页且ID不变', () => {
  const source = index(valid);
  assert.ok(sites.length >= 2400);
  const entries = prepareIndex(source);
  assert.deepEqual(Array.from(findMatches(entries, ''), (entry) => entry.id), source.sites.map((site) => site.id));
  const paged = [];
  for (let page = 1; page <= paginate(entries, 1).totalPages; page++) paged.push(...paginate(entries, page).items);
  assert.deepEqual(paged.map((entry) => entry.id), source.sites.map((site) => site.id));
  for (const id of invalid) assert.throws(() => prepareIndex(index([id])));
});
test('个人目录接受三类ID，非法ID拒绝后可重试', async () => {
  let items = invalid.map((id) => ({ ...sites[0], id }));
  const { loadPersonalSites } = runtime('src/scripts/personal-catalog.ts', ['loadPersonalSites'], {
    fetch: async () => ({ ok: true, json: async () => items }),
  });
  for (const id of invalid) {
    items = [{ ...sites[0], id }];
    await assert.rejects(loadPersonalSites());
  }
  items = [...sites, ...valid.map((id) => ({ ...sites[0], id }))];
  const catalog = await loadPersonalSites();
  assert.equal(catalog.size, new Set(items.map((site) => site.id)).size);
  for (const id of valid) assert.equal(catalog.get(id).id, id);
});
test('本地收藏、访问与迁移读取保留合法ID，过滤或拒绝非法ID', () => {
  const store = createPersonalStore(storage([...valid, ...invalid].map(record)), () => stamp);
  assert.deepEqual(store.read('favorites').map((item) => item.siteId), valid);
  for (const id of valid) {
    assert.equal(store.toggleFavorite(id), false);
    assert.equal(store.toggleFavorite(id), true);
    store.recordVisit(id, 'external');
  }
  assert.deepEqual(new Set(store.read('history').map((item) => item.siteId)), new Set(valid));
  for (const id of invalid) {
    assert.throws(() => store.toggleFavorite(id));
    assert.throws(() => store.recordVisit(id, 'detail'));
  }
});
test('服务端收藏、访问、删除和导入共用ID契约，不重命名', () => {
  for (const id of [...valid, ...invalid]) {
    const actions = [{ action: 'favorite', siteId: id, selected: true },
      { action: 'visit', siteId: id, visitType: 'external' },
      { action: 'remove', kind: 'favorites', siteId: id },
      { action: 'import', favorites: [record(id)], history: [] },
      { action: 'import', favorites: [], history: [record(id)] }];
    for (const action of actions) {
      if (valid.includes(id)) assert.deepEqual(validatePersonalAction(action), action);
      else assert.throws(() => validatePersonalAction(action), { status: 400 });
    }
  }
});
test('个人API读取与本地迁移接受新ID，响应拒绝非法ID', async () => {
  const records = valid.map(record);
  const calls = [];
  const api = createPersonalApi({ storage: storage(records), fetch: async (_url, options) => {
    if (options.body) calls.push(JSON.parse(options.body));
    return { ok: true, status: 200, json: async () => ({ data: { favorites: records, history: records } }) };
  } });
  await api.ensure();
  assert.deepEqual(api.read('favorites'), records);
  assert.deepEqual(api.read('history'), records);
  assert.deepEqual(calls, [{ action: 'import', favorites: records, history: [] }]);
  for (const id of invalid) {
    for (const kind of ['favorites', 'history']) {
      const broken = createPersonalApi({ storage: storage(), fetch: async () => ({ ok: true, status: 200,
        json: async () => ({ data: { favorites: [], history: [], [kind]: [record(id)] } }) }) });
      await assert.rejects(broken.ensure(), /个人数据响应格式错误/);
    }
  }
});
