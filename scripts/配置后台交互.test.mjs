import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import vm from 'node:vm';
const source = readFileSync(new URL('../src/scripts/admin-settings.ts', import.meta.url), 'utf8');
const snapshot = { site: { name: '品牌', url: 'https://example.test', slogan: '标语', heroTitle: '标题', heroSubtitle: '副标题', description: '介绍', keywords: '词' }, homeSectionPageSize: 18, revision: 'a'.repeat(64), writable: true };
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const controls = new Map(); const listeners = new Map(); const calls = []; const responses = [];
  const control = key => {
    if (!controls.has(key)) controls.set(key, { disabled: false, hidden: true, textContent: '', dataset: {}, addEventListener(type, fn) { listeners.set(key + ':' + type, fn); }, setAttribute() {} });
    return controls.get(key);
  };
  const fields = Object.fromEntries([...Object.keys(snapshot.site), 'homeSectionPageSize'].map(key => [key, { value: '' }]));
  const form = control('[data-settings-form]');
  form.elements = { namedItem: key => fields[key] }; form.reportValidity = () => true;
  const root = { querySelector: control };
  const context = {
    document: { querySelector: () => root },
    window: { confirm: () => true, addEventListener(type, fn) { listeners.set('window:' + type, fn); } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const next = responses.shift() ?? { status: 200, data: structuredClone(snapshot) };
      return { ok: next.status === 200, status: next.status, json: async () => next.status === 200 ? { data: next.data } : { error: { message: next.message } } };
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(source).replace(/export \{\};?/, ''), context);
  return { fields, calls, responses, control, listeners, context };
}
test('设置表单读取、保存携带revision、成功回读规范值', async () => {
  const app = setup(); await tick();
  assert.equal(app.fields.name.value, snapshot.site.name);
  assert.equal(app.control('[data-settings-save]').disabled, false);
  app.fields.name.value = '新品牌';
  app.responses.push({ status: 200, data: { ...snapshot, site: { ...snapshot.site, name: '新品牌' }, revision: 'b'.repeat(64) } });
  await app.listeners.get('[data-settings-form]:submit')({ preventDefault() {} });
  const body = JSON.parse(app.calls.at(-1).options.body);
  assert.equal(body.site.name, '新品牌');
  assert.equal(body.revision, snapshot.revision);
  assert.equal(app.calls.at(-1).options.method, 'PUT');
  assert.match(app.control('[data-settings-message]').textContent, /配置已保存/);
});
test('保存冲突保留输入和旧版本，绝不自动覆盖', async () => {
  const app = setup(); await tick(); app.fields.name.value = '未保存草稿';
  app.listeners.get('[data-settings-form]:input')();
  app.responses.push({ status: 409, message: '配置已更新，请重新加载后保存。' });
  await app.listeners.get('[data-settings-form]:submit')({ preventDefault() {} });
  assert.equal(app.fields.name.value, '未保存草稿');
  assert.equal(app.calls.length, 2);
  assert.equal(app.control('[data-settings-message]').dataset.error, 'true');
  let prevented = false;
  app.listeners.get('window:beforeunload')({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});
test('种子模式禁用编辑和提交，401显示登录恢复入口', async () => {
  const app = setup(); await tick();
  app.responses.push({ status: 200, data: { ...snapshot, writable: false } });
  app.listeners.get('[data-settings-refresh]:click')(); await tick();
  assert.equal(app.control('[data-settings-fields]').disabled, true);
  const count = app.calls.length;
  await app.listeners.get('[data-settings-form]:submit')({ preventDefault() {} });
  assert.equal(app.calls.length, count);
  app.responses.push({ status: 401, message: '请重新登录。' });
  app.listeners.get('[data-settings-refresh]:click')(); await tick();
  assert.equal(app.control('[data-settings-login]').hidden, false);
});
