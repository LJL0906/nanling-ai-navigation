import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { createPublicIndexCache } from '../src/server/public-index-cache.ts';

const request = (etag) => new Request('https://nav.test/index.json', {
  headers: etag === undefined ? {} : { 'If-None-Match': etag },
});
const snapshot = () => ({ categories: [{ slug: 'ai', name: 'AI', sites: [{
  id: 'site_a', name: 'Alpha', slug: 'alpha', url: 'https://alpha.test/', desc: '说明',
  color: '#123456', icon: null, categorySlug: 'ai', aliases: ['别名'],
  domain: 'alpha.test', tags: ['工具'], sourceCategories: ['AI工具'], sources: [{ secret: true }],
}] }], homeCategories: [], siteCount: 1, siteRedirects: [] });

test('同身份只投影及序列化一次，响应独立可重复消费', async () => {
  let projects = 0;
  let serializations = 0;
  const respond = createPublicIndexCache(() => {
    projects++;
    return { toJSON() { serializations++; return { value: '中文' }; } };
  });
  const data = snapshot();
  const responses = Array.from({ length: 10 }, () => respond(data, request()));
  assert.equal(projects, 1);
  assert.equal(serializations, 1);
  assert.equal(new Set(responses).size, 10);
  for (const response of responses) {
    assert.equal(await response.text(), '{"value":"中文"}');
    assert.equal(response.headers.get('cache-control'), 'public, no-cache');
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.match(response.headers.get('etag'), /^"[0-9a-f]{64}"$/);
  }
});

test('新身份重算；相同正文 ETag 稳定，正文变化 ETag 变化', async () => {
  let calls = 0;
  const respond = createPublicIndexCache(data => { calls++; return data.siteCount; });
  const first = respond(snapshot(), request());
  const same = respond(snapshot(), request());
  const changed = respond({ ...snapshot(), siteCount: 2 }, request(first.headers.get('etag')));
  assert.equal(calls, 3);
  assert.equal(first.headers.get('etag'), same.headers.get('etag'));
  assert.notEqual(first.headers.get('etag'), changed.headers.get('etag'));
  assert.equal(changed.status, 200);
  assert.equal(await changed.text(), '2');
});

test('各端点实例互不污染，同一个快照可以生成不同正文', async () => {
  const data = snapshot();
  const a = createPublicIndexCache(() => ['a']);
  const b = createPublicIndexCache(() => ({ b: true }));
  const first = a(data, request());
  const second = b(data, request(first.headers.get('etag')));
  assert.equal(second.status, 200);
  assert.deepEqual(await first.json(), ['a']);
  assert.deepEqual(await second.json(), { b: true });
});

test('If-None-Match 支持强标签、弱标签、多标签和星号，304 空正文', async () => {
  const data = snapshot();
  const respond = createPublicIndexCache(() => ['index']);
  const etag = respond(data, request()).headers.get('etag');
  for (const header of [etag, `W/${etag}`, `"other", W/${etag}, "last"`, ` W/${etag} `, '*', ' * ']) {
    const response = respond(data, request(header));
    assert.equal(response.status, 304, header);
    assert.equal(response.body, null);
    assert.equal(await response.text(), '');
    assert.equal(response.headers.get('etag'), etag);
    assert.equal(response.headers.get('cache-control'), 'public, no-cache');
  }
  for (const header of [undefined, '', '"other"', 'W/"other"', '"a,b"', etag.slice(1, -1)]) {
    const response = respond(data, request(header));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '["index"]');
  }
});

test('投影或序列化失败不写缓存，重试可以恢复', () => {
  for (const failSerialization of [false, true]) {
    let calls = 0;
    const respond = createPublicIndexCache(() => {
      calls++;
      if (calls > 1) return [];
      if (!failSerialization) throw new Error('projection failed');
      return { toJSON() { throw new Error('serialization failed'); } };
    });
    const data = snapshot();
    assert.throws(() => respond(data, request('*')), /failed/);
    assert.equal(respond(data, request()).status, 200);
    assert.equal(calls, 2);
  }
});

// 执行完整端点，只替换导航来源，避免加载 Astro 或读取环境配置。
function loadEndpoint(name, getNavigation) {
  const source = readFileSync(new URL(`../src/pages/${name}.json.ts`, import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source)
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export /gm, '');
  return runInNewContext(`${code}\nGET;`, { getNavigation, createPublicIndexCache, Response, URL });
}
const expected = {
  'search-index': {
    version: 1, categories: [{ slug: 'ai', name: 'AI' }], sites: [{
      id: 'site_a', url: 'https://alpha.test/', slug: 'alpha', name: 'Alpha', desc: '说明',
      color: '#123456', icon: null, category: 0, terms: '别名\nalpha.test\n工具\nAI工具',
    }],
  },
  'personal-sites': [{ id: 'site_a', name: 'Alpha', slug: 'alpha', url: 'https://alpha.test/',
    desc: '说明', color: '#123456', icon: null, categorySlug: 'ai', categoryName: 'AI' }],
  'history-destinations': { alpha: 'https://alpha.test/', 'https://alpha.test': 'https://alpha.test/',
    'alpha.test': 'https://alpha.test/', '别名': 'https://alpha.test/' },
};
for (const name of Object.keys(expected)) {
  test(`${name} 保持原 JSON 结构，每次取快照，换身份重算且不吞读取失败`, async () => {
    let current = snapshot();
    let reads = 0;
    let fail = false;
    const GET = loadEndpoint(name, async () => { reads++; if (fail) throw new Error('database unavailable'); return current; });
    const first = await GET({ request: request() });
    assert.deepEqual(await first.json(), expected[name]);
    const etag = first.headers.get('etag');
    assert.equal((await GET({ request: request(`W/${etag}`) })).status, 304);
    assert.equal(reads, 2);
    current = snapshot();
    current.categories[0].sites[0].url = 'https://changed.test/';
    const next = await GET({ request: request(etag) });
    assert.equal(next.status, 200);
    assert.notEqual(next.headers.get('etag'), etag);
    assert.match(await next.text(), /changed\.test/);
    fail = true;
    await assert.rejects(GET({ request: request('*') }), /database unavailable/);
  });
}

test('历史索引继续保留歧义词的 null 和空词过滤', async () => {
  const data = snapshot();
  data.categories[0].sites.push({ ...data.categories[0].sites[0], url: 'https://other.test/', aliases: [' ', '别名'] });
  const GET = loadEndpoint('history-destinations', async () => data);
  const json = await (await GET({ request: request() })).json();
  assert.equal(json.alpha, null);
  assert.equal(json['别名'], null);
  assert.equal(Object.hasOwn(json, ''), false);
});
