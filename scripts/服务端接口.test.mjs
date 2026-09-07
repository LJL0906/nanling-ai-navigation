import test from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin } from '../src/server/auth.ts';
import { parseSiteQuery, listSites, siteSummary } from '../src/server/site-query.ts';
import { api, HttpError, methodNotAllowed } from '../src/server/http.ts';

const token = 'a'.repeat(64);
const request = (headers = {}) => new Request('https://example.test/api/admin/status', { headers });
const site = { id: 'site_a', slug: 'alpha', name: 'Alpha', url: 'https://example.test', desc: '文字生成',
  categorySlug: 'ai', domain: 'example.test', aliases: ['阿尔法'], tags: ['免费'], sourceCategories: ['AI写作'],
  icon: null, color: '#3777f5', verification: { status: 'unverified', checkedAt: null }, sources: [{ private: true }] };
const snapshot = { categories: [{ slug: 'ai', name: 'AI 工具', sites: [site] }], siteCount: 1 };

test('管理员令牌缺省或过短时关闭入口', () => {
  for (const value of ['', 'short', ' ' + token]) {
    assert.throws(() => requireAdmin(request(), value), (error) => error.status === 503);
  }
});
test('只接受正确Bearer令牌，拒绝无效凭据', () => {
  assert.doesNotThrow(() => requireAdmin(request({ Authorization: `Bearer ${token}` }), token));
  for (const value of ['', `Basic ${token}`, `Bearer ${'b'.repeat(64)}`, 'Bearer x', `Bearer ${'x'.repeat(513)}`]) {
    assert.throws(() => requireAdmin(request({ Authorization: value }), token), (error) => error.status === 401);
  }
  assert.throws(() => requireAdmin(new Request(`https://example.test/?token=${token}`), token), (error) => error.status === 401);
});
test('分页参数有默认值和上限，拒绝非法和过大的值', () => {
  assert.deepEqual(parseSiteQuery(new URLSearchParams()), { q: '', category: '', page: 1, pageSize: 48 });
  for (const query of ['page=0', 'page=-1', 'page=1.2', 'page=1000001', 'pageSize=101', 'pageSize=0', 'page=1e2', 'category=../x', `q=${'a'.repeat(201)}`]) {
    assert.throws(() => parseSiteQuery(new URLSearchParams(query)), (error) => error.status === 400);
  }
});
test('服务端搜索覆盖名称、别名、域名、标签和分类；返回精简字段', () => {
  for (const q of ['Alpha', '阿尔法', 'example.test', '免费', 'AI写作', '文字生成', 'AI 工具']) {
    const result = listSites(snapshot, parseSiteQuery(new URLSearchParams({ q })));
    assert.equal(result.pagination.total, 1, q);
    assert.equal(result.data[0].id, 'site_a');
    assert.ok(!('sources' in result.data[0]));
  }
  assert.equal(listSites(snapshot, parseSiteQuery(new URLSearchParams({ q: '无匹配' }))).data.length, 0);
  assert.equal(listSites(snapshot, parseSiteQuery(new URLSearchParams({ page: '2' }))).data.length, 0);
  assert.throws(() => listSites(snapshot, parseSiteQuery(new URLSearchParams({ category: 'missing' }))), (error) => error.status === 404);
  assert.ok(!('aliases' in siteSummary(site)));
});
test('JSON错误响应结构稳定且不泄漏内部异常', async () => {
  const bad = await api(() => { throw new HttpError(400, 'INVALID', '参数错误'); });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, 'INVALID');
  const original = console.error;
  console.error = () => {};
  try {
    const failure = await api(() => { throw new Error('postgres://secret:password@db'); });
    assert.equal(failure.status, 500);
    assert.ok(!(await failure.text()).includes('password'));
    assert.equal(failure.headers.get('Cache-Control'), 'no-store');
  } finally { console.error = original; }
  const unsupported = methodNotAllowed();
  assert.equal(unsupported.status, 405);
  assert.equal(unsupported.headers.get('Allow'), 'GET, HEAD');
});
