import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as menuOrder from '../src/lib/menu-order.ts';

const source = readFileSync(new URL('../src/scripts/sidebarOrder.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const defaults = ['home', 'tools', 'about'];

// 只仿真脚本使用的 DOM；排序及存储逻辑均执行真实源码。
class Element {
  constructor(dataset = {}) {
    Object.assign(this, { dataset, children: [], listeners: {}, attributes: new Set(),
      captures: new Set(), textContent: '', disabled: false, scrollTop: 0 });
    const classes = new Set();
    this.classList = { add: (name) => classes.add(name), remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name) };
  }
  matches(selector) {
    const key = selector.slice(6, -1).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    return Object.hasOwn(this.dataset, key);
  }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) ?? null; }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node === before) return;
    if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1);
    const index = before === null ? this.children.length : this.children.indexOf(before);
    assert.ok(index >= 0, '插入锚点必须属于当前父节点');
    this.children.splice(index, 0, node);
    node.parent = this;
  }
  get nextElementSibling() {
    return this.parent?.children[this.parent.children.indexOf(this) + 1] ?? null;
  }
  toggleAttribute(name, force) { if (force) this.attributes.add(name); else this.attributes.delete(name); }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollIntoView(options) { this.scrollOptions = options; }
  getBoundingClientRect() {
    const top = this.dataset.menuId ? this.parent.children.indexOf(this) * 40 : 0;
    const height = this.dataset.menuId ? 40 : 160;
    return { left: 0, right: 200, top, bottom: top + height, height };
  }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) {
    this.captures.delete(id);
    this.dispatch('lostpointercapture', { pointerId: id });
  }
  addEventListener(name, callback, options = {}) {
    (this.listeners[name] ??= []).push({ callback, signal: options.signal, capture: !!options.capture });
  }
  listenerCount(name) { return (this.listeners[name] ?? []).filter((entry) => !entry.signal?.aborted).length; }
  dispatchEvent(event) { this.dispatch(event.type, { detail: event.detail }); return true; }
  dispatch(name, properties = {}) {
    const event = { target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      ...properties };
    const path = [];
    for (let node = this; node; node = node.parent) path.push(node);
    const invoke = (node, capture) => {
      for (const entry of [...(node.listeners[name] ?? [])]) {
        if (!entry.signal?.aborted && entry.capture === capture) entry.callback(event);
      }
    };
    for (const node of [...path].reverse()) { invoke(node, true); if (event.stopped) return event; }
    for (const node of path) { invoke(node, false); if (event.stopped) break; }
    return event;
  }
}

function setup({ saved, blocked = false, failWrite = false, ids = defaults } = {}) {
  const document = new Element(), window = new Element();
  const list = new Element({ menuOrder: '' }), scroller = new Element({ menuScroll: '' });
  const status = new Element({ menuStatus: '' });
  const handles = {}, items = {};
  for (const id of ids) {
    items[id] = new Element({ menuId: id });
    handles[id] = new Element({ menuHandle: '' });
    items[id].append(handles[id]);
    list.append(items[id]);
  }
  scroller.append(list);
  document.append(scroller, status);
  const values = new Map(saved ? [[menuOrder.MENU_ORDER_KEY, JSON.stringify(saved)]] : []);
  const writes = [], frames = new Map();
  let frameId = 0;
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) {
      if (failWrite) throw new Error('quota');
      writes.push([key, value]); values.set(key, value);
    },
  };
  const notifications = [];
  document.addEventListener('nav:menu-order-change', (event) => notifications.push([...event.detail]));
  const context = { exports: {}, document, window, AbortController, CustomEvent,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    require(name) { assert.equal(name, '../lib/menu-order'); return menuOrder; },
  };
  Object.defineProperty(context, 'localStorage', { get() {
    if (blocked) throw new Error('SecurityError');
    return storage;
  } });
  vm.runInNewContext(code, context, { timeout: 1000 });
  const order = () => list.children.map((item) => item.dataset.menuId);
  const key = (id, name) => handles[id].dispatch('keydown', { key: name });
  const pointer = (name, target, properties = {}) => {
    const event = { pointerId: 7, button: 0, isPrimary: true, clientX: 100, clientY: 20, ...properties };
    const captured = [list, ...Object.values(items), ...Object.values(handles)]
      .find((node) => node.hasPointerCapture(event.pointerId));
    return (captured ?? target).dispatch(name, event);
  };
  const drag = () => {
    pointer('pointerdown', handles.home);
    pointer('pointermove', handles.home, { clientY: 115 });
    assert.deepEqual(order(), ['tools', 'about', 'home']);
  };
  return { document, window, list, status, handles, items, values, writes,
    frames, order, key, pointer, drag, notifications };
}
function assertSaved(state, expected) {
  assert.deepEqual(state.writes.at(-1), [menuOrder.MENU_ORDER_KEY, JSON.stringify(expected)]);
  assert.deepEqual(JSON.parse(state.values.get(menuOrder.MENU_ORDER_KEY)), expected);
  assert.equal(state.status.attributes.has('data-error'), false);
  assert.match(state.status.textContent, /已保存/);
}
function assertFinished(state) {
  assert.equal(state.list.hasPointerCapture(7), false);
  assert.equal(state.list.classList.contains('is-sorting'), false);
  assert.equal(state.items.home.classList.contains('is-dragging'), false);
  assert.equal(state.frames.size, 0);
  assert.equal(state.handles.home.focused, true);
}

test('键盘四种重排键执行真实排序、保存并保持焦点', () => {
  const state = setup();
  for (const [key, expected] of [
    ['ArrowDown', ['tools', 'home', 'about']], ['End', ['tools', 'about', 'home']],
    ['ArrowUp', ['tools', 'home', 'about']], ['Home', defaults],
  ]) {
    assert.equal(state.key('home', key).defaultPrevented, true);
    assert.deepEqual(state.order(), expected);
    assertSaved(state, expected);
  }
  assert.equal(state.writes.length, 4);
  assert.equal(state.handles.home.focusOptions.preventScroll, true);
  assert.equal(state.items.home.scrollOptions.block, 'nearest');
  state.key('home', 'ArrowUp');
  state.key('about', 'ArrowDown');
  assert.equal(state.key('home', 'Enter').defaultPrevented, false);
  assert.equal(state.writes.length, 4, '边界和无关按键不保存');
});

test('pointer drag 在列表捕获指针，移动行后仍能完成排序且只保存一次', () => {
  const state = setup();
  state.drag();
  assert.equal(state.list.hasPointerCapture(7), true);
  assert.equal(state.items.home.hasPointerCapture(7), false);
  assert.equal(state.handles.home.hasPointerCapture(7), false);
  assert.equal(state.list.classList.contains('is-sorting'), true);
  assert.equal(state.items.home.classList.contains('is-dragging'), true);
  assert.equal(state.frames.size, 1);
  assert.equal(state.writes.length, 0, '拖动中不保存');
  state.pointer('pointerup', state.handles.home, { clientY: 115 });
  assertSaved(state, ['tools', 'about', 'home']);
  assert.equal(state.writes.length, 1);
  assertFinished(state);
});

for (const reason of ['pointercancel', 'Escape']) {
  test(`${reason} 还原拖动前顺序，不覆盖已有存储并清理捕获`, () => {
    const original = ['home', 'about', 'tools'];
    const state = setup({ saved: original });
    state.pointer('pointerdown', state.handles.home);
    state.pointer('pointermove', state.handles.home, { clientY: 115 });
    assert.deepEqual(state.order(), ['about', 'tools', 'home']);
    if (reason === 'Escape') {
      const event = state.key('home', 'Escape');
      assert.equal(event.defaultPrevented, true);
      assert.equal(event.stopped, true);
    } else state.pointer(reason, state.handles.home);
    assert.deepEqual(state.order(), original);
    assert.equal(state.values.get(menuOrder.MENU_ORDER_KEY), JSON.stringify(original));
    assert.equal(state.writes.length, 0);
    assert.match(state.status.textContent, /已取消/);
    assertFinished(state);
    state.pointer('pointerup', state.handles.home, { clientY: 115 });
    assert.equal(state.writes.length, 0);
  });
}

for (const failure of [{ blocked: true }, { failWrite: true }]) {
  test(`存储${failure.blocked ? '访问禁用' : '写入失败'}时仍可排序并显示错误`, () => {
    const state = setup(failure);
    assert.deepEqual(state.order(), defaults);
    state.key('home', 'End');
    assert.deepEqual(state.order(), ['tools', 'about', 'home']);
    assert.equal(state.writes.length, 0);
    assert.equal(state.status.attributes.has('data-error'), true);
    assert.match(state.status.textContent, /存储不可用/);
  });
}

test('没有恢复按钮时仍恢复顺序，页面回访不重复监听，离开后清理监听', () => {
  const state = setup({ saved: ['tools', 'home', 'about'] });
  assert.equal(state.document.querySelector('[data-menu-reset]'), null);
  assert.deepEqual(state.order(), ['tools', 'home', 'about']);
  const counts = () => [state.list, state.document, state.window]
    .map((node) => Object.keys(node.listeners).map((name) => [name, node.listenerCount(name)]));
  const initialCounts = counts();
  for (let i = 0; i < 3; i++) state.document.dispatch('astro:page-load');
  assert.deepEqual(counts(), initialCounts);
  state.key('home', 'ArrowUp');
  assert.deepEqual(state.order(), defaults);
  assert.equal(state.writes.length, 1);
  state.key('home', 'End');
  state.document.dispatch('astro:page-load');
  assert.deepEqual(state.order(), ['tools', 'about', 'home']);
  assert.equal(state.writes.length, 2);
  assert.deepEqual(counts(), initialCounts);
  state.document.dispatch('astro:before-swap');
  state.key('home', 'Home');
  assert.deepEqual(state.order(), ['tools', 'about', 'home']);
  assert.equal(state.writes.length, 2);
});

test('首页固定首位：旧顺序恢复、键盘及拖拽均不能移动首页或越过首页', () => {
  const ids = ['/', '/tools/', '/about/'];
  const state = setup({ ids, saved: ['/about/', '/', '/tools/'] });
  assert.deepEqual(state.order(), ['/', '/about/', '/tools/']);
  assert.deepEqual(state.notifications.at(-1), state.order());
  // 仿真故意保留首页手柄，以验证脚本本身也拒绝首页排序。
  state.key('/', 'End');
  state.pointer('pointerdown', state.handles['/']);
  assert.equal(state.list.hasPointerCapture(7), false);
  assert.deepEqual(state.order(), ['/', '/about/', '/tools/']);
  state.key('/tools/', 'Home');
  assert.deepEqual(state.order(), ids);
  state.key('/tools/', 'ArrowUp');
  assert.deepEqual(state.order(), ids);
  state.pointer('pointerdown', state.handles['/about/'], { clientY: 100 });
  state.pointer('pointermove', state.handles['/about/'], { clientY: 1 });
  state.pointer('pointerup', state.handles['/about/'], { clientY: 1 });
  assert.deepEqual(state.order(), ['/', '/about/', '/tools/']);
  assertSaved(state, state.order());
  assert.deepEqual(state.notifications.at(-1), state.order());
  state.key('/tools/', 'Home');
  assert.deepEqual(state.notifications.at(-1), ids);
});

test('存储失败也广播新顺序，取消拖动与跨标签页更新广播实际顺序', () => {
  const state = setup({ failWrite: true });
  state.key('home', 'End');
  assert.deepEqual(state.notifications.at(-1), state.order());
  state.pointer('pointerdown', state.handles.home, { clientY: 115 });
  state.pointer('pointermove', state.handles.home, { clientY: 1 });
  state.pointer('pointercancel', state.handles.home);
  assert.deepEqual(state.notifications.at(-1), ['tools', 'about', 'home']);
  state.values.set(menuOrder.MENU_ORDER_KEY, JSON.stringify(['about', 'home', 'tools']));
  state.window.dispatch('storage', { key: menuOrder.MENU_ORDER_KEY });
  assert.deepEqual(state.notifications.at(-1), ['about', 'home', 'tools']);
});

test('首页模板不输出拖拽手柄，保留正常导航链接', () => {
  const template = readFileSync(new URL('../src/components/layout/Sidebar.astro', import.meta.url), 'utf8');
  assert.match(template, /menuId\(item\) !== '\/' && <button\s+type="button"\s+class="menu-order-handle"/);
  assert.ok(template.includes('data-home-start='));
});

test('侧边栏移除导航小标题和恢复默认控件，不保留空白标题行', () => {
  const template = readFileSync(new URL('../src/components/layout/Sidebar.astro', import.meta.url), 'utf8');
  assert.doesNotMatch(template, /data-menu-reset|menu-order-reset|恢复默认|>导航<|mb-2 flex items-center justify-between px-3/);
  assert.ok(template.includes('data-menu-order'));
  assert.ok(template.includes('data-menu-handle'));
});
