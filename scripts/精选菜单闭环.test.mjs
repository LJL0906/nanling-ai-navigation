import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { curatedGroupsFromMenus } from '../src/lib/curated-menu-directory.ts';
import { safeCuratedHref, curatedPayloadError, mergeCuratedFields, validCheckedAt } from '../src/lib/curated-menu-fields.ts';
import { validateMenus, visibleMenus } from '../src/server/menu-validation.ts';

const group = (patch = {}) => ({ id: 'g', parentId: null, location: 'topbar', kind: 'group', label: '分组', href: null, icon: null, sortOrder: 0, enabled: true, payload: { groupId: 'tools', description: '分组描述' }, ...patch });
const resource = (patch = {}) => ({ ...group(), id: 'r', parentId: 'g', kind: 'resource', label: '资源', href: 'https://example.com/', payload: { description: '描述', useCase: '用途', sourceUrl: 'https://example.com/docs', sourceTitle: '文档', checkedAt: '2024-02-29', name: '旧名称', url: 'https://old.example/' }, ...patch });
const project = rows => curatedGroupsFromMenus(visibleMenus(validateMenus(rows)));

test('入库字段是唯一来源，保留旧分组锚点，不使用 payload 中陈旧名称或 URL', () => {
  const rows = [group(), resource()]; const before = structuredClone(rows);
  const [g] = project(rows);
  assert.equal(g.id, 'tools'); assert.equal(g.icon, 'lucide:folder');
  assert.equal(g.resources[0].name, '资源'); assert.equal(g.resources[0].url, 'https://example.com/');
  assert.equal(g.resources[0].sourceTitle, '文档'); assert.deepEqual(rows, before);
});
test('新增、编辑、移动、隐藏、删除资源和分组，下一次投影即同步', () => {
  let rows = [group(), resource()];
  rows.push(group({ id: 'g2', sortOrder: 2, payload: {} }));
  rows.push(resource({ id: 'r2', sortOrder: 1 }));
  assert.equal(project(rows)[0].resources.length, 2);
  rows[1] = resource({ label: '新名称', href: '/local/', parentId: 'g2', payload: { description: '新描述' } });
  const moved = project(rows)[1].resources[0];
  assert.equal(moved.name, '新名称'); assert.equal(moved.domain, '站内资源'); assert.equal(moved.description, '新描述');
  assert.equal(moved.sourceUrl, ''); assert.equal(moved.checkedAt, '');
  rows[2].enabled = false; assert.equal(project(rows).length, 1);
  rows = rows.filter(m => m.id !== 'g2' && m.parentId !== 'g2');
  assert.equal(project(rows).flatMap(g => g.resources).length, 1);
  rows = rows.filter(m => m.kind !== 'resource');
  assert.deepEqual(project(rows)[0].resources, []);
  assert.deepEqual(curatedGroupsFromMenus([]), []);
});
test('排序稳定，过滤普通链接、其他区域及隐藏父子项', () => {
  const rows = [resource({ id: 'b', sortOrder: 9 }), resource({ id: 'a', sortOrder: 9 }), group(), resource({ id: 'hidden', enabled: false }), resource({ id: 'link', kind: 'link' }), group({ id: 'actions', location: 'topbar-actions', payload: {} })];
  assert.deepEqual(project(rows)[0].resources.map(r => r.id), ['a', 'b']);
  rows.find(m => m.id === 'g').enabled = false;
  assert.deepEqual(project(rows), []);
});
for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.test', '/%2fevil.test', '/%5cevil.test', '/ok%0aX', 'https://user:pass@example.com', 'https://user@example.com', 'https:\\evil.test', 'https:evil.test', 'https:///evil.test\\x', 'https://example.com/%0dX', 'https://example.com/ a', ' https://example.com/', 'https://example.com/\u007f']) {
  test(`危险链接拒绝：${JSON.stringify(url)}`, () => {
    assert.equal(safeCuratedHref(url, true), false);
    assert.throws(() => validateMenus([group(), resource({ href: url })]));
    assert.throws(() => validateMenus([group(), resource({ payload: { sourceUrl: url } })]));
  });
}
test('来源只接受外链，资源也支持站内链接；服务端与投影均拒绝脏来源', () => {
  assert.equal(safeCuratedHref('/tools/', true), true);
  assert.equal(safeCuratedHref('/tools/'), false);
  assert.equal(safeCuratedHref('https://例子.中国/文档?q=1#info'), true);
  for (const sourceUrl of ['/internal/', 'javascript:alert(1)', null, 123]) {
    assert.throws(() => validateMenus([group(), resource({ payload: { sourceUrl } })]));
    assert.throws(() => curatedGroupsFromMenus([group(), resource({ payload: { sourceUrl } })]));
  }
});
test('核对日期验证闰年、格式、真实日历，缺项不虚构日期', () => {
  assert.equal(validCheckedAt('2024-02-29'), true);
  for (const checkedAt of ['2025-02-29', '2026-04-31', '2026-13-01', '2026-2-01', 'yesterday']) {
    assert.equal(validCheckedAt(checkedAt), false);
    assert.throws(() => validateMenus([group(), resource({ payload: { checkedAt } })]));
  }
  assert.equal(curatedPayloadError({ checkedAt: '', sourceUrl: '' }), null);
});
test('可视化字段覆盖、删除、JSON 保留与安全校验', () => {
  const original = { sourceTitle: 'JSON标题', target: '_blank', extra: { retained: true }, description: '旧描述' };
  assert.deepEqual(mergeCuratedFields(original, { description: ' 新描述 ', sourceTitle: '' }), { description: '新描述', target: '_blank', extra: { retained: true } });
  assert.equal(original.sourceTitle, 'JSON标题');
  assert.equal(mergeCuratedFields(original, {}).sourceTitle, 'JSON标题');
  assert.throws(() => mergeCuratedFields(original, { sourceUrl: 'javascript:x' }));
  assert.throws(() => mergeCuratedFields(original, { sourceTitle: 'x'.repeat(256) }));
  assert.throws(() => mergeCuratedFields(original, { description: '\u0000' }));
});
test('discover 实时读取、不导入静态、不吞错误；空态、缺项及安全新窗口声明', () => {
  const page = readFileSync(new URL('../src/pages/discover/index.astro', import.meta.url), 'utf8');
  assert.match(page, /await getPublicMenus\(\)/); assert.match(page, /prerender = false/);
  assert.match(page, /Cache-Control.*no-store/); assert.doesNotMatch(page, /RESOURCE_GROUPS|data\/curated-resources|catch\s*\(/);
  for (const text of ['暂无公开精选分组', '此分组暂无公开资源', '暂未填写来源', '暂未填写核对日期', 'rel="noopener noreferrer"']) assert.ok(page.includes(text));
});
