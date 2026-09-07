import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RESOURCE_GROUPS } from '../src/data/curated-resources.ts';

const expectedGroups = [
  ['ai-work', 'AI 效率', 'lucide:sparkles'],
  ['creative', '创作设计', 'lucide:palette'],
  ['dev-learn', '开发学习', 'lucide:code-xml'],
];
const resourceFields = [
  'id', 'name', 'url', 'description', 'useCase',
  'sourceUrl', 'sourceTitle', 'checkedAt',
];
const resources = RESOURCE_GROUPS.flatMap((group) => group.resources);

function assertText(value, label) {
  assert.equal(typeof value, 'string', label);
  assert.ok(value.trim().length > 0, label + ' 不能为空');
  assert.equal(value, value.trim(), label + ' 不应含首尾空白');
}

function assertHttps(value, label) {
  const url = new URL(value);
  assert.equal(url.protocol, 'https:', label + ' 必须为 HTTPS');
  assert.ok(url.hostname.includes('.'), label + ' 必须有完整域名');
  assert.equal(url.username, '', label + ' 不应含用户名');
  assert.equal(url.password, '', label + ' 不应含密码');
  return url;
}

function normalizedUrl(value) {
  const url = new URL(value);
  url.hostname = url.hostname.replace(/^www\./, '');
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.href;
}

test('固定三组 ID、中文标签、Lucide 图标与顺序', () => {
  assert.ok(Array.isArray(RESOURCE_GROUPS));
  assert.deepEqual(
    RESOURCE_GROUPS.map(({ id, label, icon }) => [id, label, icon]),
    expectedGroups,
  );
  assert.equal(new Set(RESOURCE_GROUPS.map(({ id }) => id)).size, 3);
});

test('分组字段完整，且每组恰好六项、合计十八项', () => {
  for (const group of RESOURCE_GROUPS) {
    assert.deepEqual(Object.keys(group).sort(), [
      'id', 'label', 'icon', 'description', 'resources',
    ].sort());
    for (const field of ['id', 'label', 'icon', 'description']) {
      assertText(group[field], group.id + '.' + field);
    }
    assert.ok(Array.isArray(group.resources));
    assert.equal(group.resources.length, 6, group.id);
  }
  assert.equal(resources.length, 18);
});

test('资源严格包含接口要求的八个非空字符串字段', () => {
  for (const resource of resources) {
    assert.deepEqual(Object.keys(resource).sort(), [...resourceFields].sort());
    for (const field of resourceFields) {
      assertText(resource[field], resource.id + '.' + field);
    }
    assert.match(resource.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});

test('描述与用途为简洁中文，不额外宣传价格、排名或可用性', () => {
  for (const resource of resources) {
    for (const field of ['description', 'useCase']) {
      assert.match(resource[field], /[\u4e00-\u9fff]/, resource.id + '.' + field);
      assert.ok(resource[field].length <= 100, resource.id + '.' + field);
      assert.doesNotMatch(resource[field], /免费|排名|第一|最新版本|国内可用|全站已验证/);
    }
  }
});

test('产品地址与来源地址均为无凭据的 HTTPS URL', () => {
  for (const resource of resources) {
    assertHttps(resource.url, resource.id + '.url');
    assertHttps(resource.sourceUrl, resource.id + '.sourceUrl');
  }
});

test('十八项资源 ID 与产品 URL 全局唯一', () => {
  assert.equal(new Set(resources.map(({ id }) => id)).size, 18);
  assert.equal(new Set(resources.map(({ url }) => url)).size, 18);
  assert.equal(new Set(resources.map(({ url }) => normalizedUrl(url))).size, 18);
});

test('核对日期为有效日期，并固定为 2026-09-07', () => {
  for (const resource of resources) {
    assert.match(resource.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(resource.checkedAt, '2026-09-07');
    const date = new Date(resource.checkedAt + 'T00:00:00.000Z');
    assert.equal(date.toISOString().slice(0, 10), resource.checkedAt);
  }
});

test('来源文档记录所有产品入口、来源标题、URL 与核对边界', async () => {
  const doc = await readFile(new URL('../docs/精选导航来源.md', import.meta.url), 'utf8');
  assert.ok(doc.includes('2026-09-07'));
  assert.ok(doc.includes('/discover/'));
  assert.ok(doc.includes('2400'));
  assert.ok(doc.includes('不是产品功能实测、在线可用性验证或安全保证'));
  assert.ok(doc.includes('web.run') && doc.includes('返回空白'));
  for (const resource of resources) {
    assert.ok(doc.includes('(' + resource.url + ')'), resource.id + ' 产品入口缺失');
    assert.ok(doc.includes('(' + resource.sourceUrl + ')'), resource.id + ' 来源 URL 缺失');
    assert.ok(doc.includes(resource.sourceTitle.replace(/\|/g, '\\|')), resource.id + ' 来源标题缺失');
    assert.ok(doc.includes('\x60' + resource.id + '\x60'), resource.id + ' 来源记录缺失');
  }
});
