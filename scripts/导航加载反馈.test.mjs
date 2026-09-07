import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
const source = readFileSync(new URL('../src/scripts/navigation-progress.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
function setup() {
  const handlers = new Map();
  const timers = new Map();
  const message = { textContent: '' };
  const feedback = { hidden: true, querySelector: () => message };
  let id = 0;
  const listen = (name, action) => handlers.set(name, action);
  vm.runInNewContext(code, { exports: {}, document: { querySelector: () => feedback, addEventListener: listen },
    window: { addEventListener: listen }, setTimeout: action => { timers.set(++id, action); return id; },
    clearTimeout: key => timers.delete(key), Symbol });
  function start(loader = async () => {}) {
    const controller = new AbortController();
    const event = { signal: controller.signal, loader, defaultPrevented: false };
    handlers.get('astro:before-preparation')(event);
    return { event, abort: () => controller.abort() };
  }
  return { start, feedback, message, timers, emit: name => handlers.get(name)(), tick: () => [...timers.values()].forEach(action => action()) };
}
test('页面切换立即显示反馈，交换后清理提示与定时器', async () => {
  const state = setup(); let calls = 0;
  const request = state.start(async () => { calls++; });
  assert.equal(state.feedback.hidden, false);
  assert.equal(state.message.textContent, '正在加载页面…');
  await request.event.loader(); assert.equal(calls, 1);
  state.emit('astro:after-swap');
  assert.equal(state.feedback.hidden, true); assert.equal(state.timers.size, 0);
});
test('慢请求有明确提示，取消后清理', () => {
  const state = setup(); const request = state.start(); state.tick();
  assert.match(state.message.textContent, /较慢/); request.abort();
  assert.equal(state.feedback.hidden, true); assert.equal(state.timers.size, 0);
});
test('旧请求取消或失败不能清理新请求反馈', async () => {
  const state = setup(); const old = state.start(async () => { throw new Error('failed'); });
  state.start(); old.abort(); await assert.rejects(old.event.loader(), /failed/);
  assert.equal(state.feedback.hidden, false); assert.equal(state.message.textContent, '正在加载页面…');
});
test('加载异常保留原异常并显示失败提示，不留下慢请求定时器', async () => {
  const state = setup(); const error = new Error('network');
  const request = state.start(async () => { throw error; });
  await assert.rejects(request.event.loader(), error);
  assert.match(state.message.textContent, /失败/); assert.equal(state.timers.size, 0);
  state.emit('pageshow'); assert.equal(state.feedback.hidden, true);
});
test('原加载器取消导航时清除反馈，不改变原导航行为', async () => {
  const state = setup(); const request = state.start(async () => { request.event.defaultPrevented = true; });
  await request.event.loader(); assert.equal(state.feedback.hidden, true);
});
test('反馈不绑定链接点击，不阻止交互，且尊重减少动画偏好', () => {
  const component = readFileSync(new URL('../src/components/layout/NavigationFeedback.astro', import.meta.url), 'utf8');
  assert.match(component, /pointer-events: none/); assert.match(component, /prefers-reduced-motion/);
  assert.doesNotMatch(source, /preventDefault\(|stopPropagation\(|addEventListener\('click'/);
});
test('一次页面请求只加载一份菜单，顶栏和侧栏通过props复用', () => {
  const layout = readFileSync(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');
  assert.equal((layout.match(/await getPublicMenus\(\)/g) ?? []).length, 1);
  for (const name of ['Sidebar', 'Topbar']) {
    assert.ok(layout.includes(`<${name} menus={menus} />`));
    const component = readFileSync(new URL(`../src/components/layout/${name}.astro`, import.meta.url), 'utf8');
    assert.doesNotMatch(component, /getPublicMenus\(/);
  }
});

test('首页并行读取菜单和站点并向布局传递，避免冷启动串行查询', () => {
  const page = readFileSync(new URL('../src/pages/index.astro', import.meta.url), 'utf8');
  const layout = readFileSync(new URL('../src/layouts/BaseLayout.astro', import.meta.url), 'utf8');
  assert.match(page, /Promise\.all\(\[getNavigation\(\), getPublicMenus\(\)\]\)/);
  assert.ok(page.includes('menus={menus}'));
  assert.ok(layout.includes('Astro.props.menus ?? await getPublicMenus()'));
});
