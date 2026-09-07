import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { parse } from '@astrojs/compiler';
import * as menuOrder from '../src/lib/menu-order.ts';
import * as homeSections from '../src/lib/home-sections.ts';

const source = readFileSync(new URL('../src/scripts/homeNavigation.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ast } = await parse(readFileSync(new URL('../src/components/home/SiteCard.astro', import.meta.url), 'utf8'));
function findLink(node, className) {
  if (node.name === 'a' && node.attributes?.some((attr) => attr.name === 'class' && attr.value.split(/\s+/).includes(className))) return node;
  return (node.children ?? []).map((child) => findLink(child, className)).find(Boolean);
}
function templateAttributes(className) {
  const link = findLink(ast, className);
  assert.ok(link, `真实 SiteCard 模板缺少 ${className}`);
  // 动态脚本继承模板的 target/rel，不能在 fake DOM 中硬编码安全属性而掩盖回归。
  return Object.fromEntries(link.attributes.filter((attr) => attr.kind === 'quoted').map((attr) => [attr.name, attr.value]));
}
const primaryAttributes = templateAttributes('nav-card-detail');
const externalAttributes = templateAttributes('nav-card-external');

class Element {
  constructor(attributes = {}) {
    this.attributes = { ...attributes };
    this.dataset = {};
    this.style = {};
    this.children = [];
    this.selectors = {};
    this.listeners = {};
    this.hidden = false;
  }
  get href() { return this.attributes.href; }
  set href(value) { this.attributes.href = value; }
  get target() { return this.attributes.target; }
  get rel() { return this.attributes.rel; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector) {
    if (selector === '[data-home-section]') return this.children.filter((child) => child.dataset.homeSection);
    const result = this.selectors[selector];
    return result ? (Array.isArray(result) ? result : [result]) : [];
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, callback, options = {}) {
    (this.listeners[name] ??= []).push({ callback, signal: options.signal });
  }
  dispatch(name, event = {}) {
    for (const listener of this.listeners[name] ?? []) {
      if (!listener.signal?.aborted) listener.callback(event);
    }
  }
  dispatchEvent(event) { this.dispatch(event.type, event); }
  remove() {
    if (this.parentElement) {
      const siblings = this.parentElement.children;
      siblings.splice(siblings.indexOf(this), 1);
      this.parentElement = null;
    }
  }
  replaceWith(node) {
    const parent = this.parentElement;
    assert.ok(parent, '替换节点必须位于 DOM 中');
    node.remove();
    const index = parent.children.indexOf(this);
    parent.children.splice(index, 1, node);
    node.parentElement = parent;
    this.parentElement = null;
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.isFragment) this.append(...node.children.splice(0));
      else {
        node.remove();
        node.parentElement = this;
        this.children.push(node);
      }
    }
  }
  replaceChildren(...nodes) { this.children.slice().forEach((node) => node.remove()); this.append(...nodes); }
  focus(options) { this.focused = true; this.focusOptions = options; }
  getBoundingClientRect() { return { top: 200 }; }
}
function fragment() {
  const result = new Element();
  result.isFragment = true;
  return result;
}
function cloneCard() {
  const card = new Element();
  const primary = new Element(primaryAttributes);
  const external = new Element(externalAttributes);
  const favorite = new Element();
  const icon = new Element();
  icon.selectors.span = new Element();
  card.selectors = {
    '[data-site-id]': card, '[data-favorite-id]': favorite,
    '.nav-card-detail': primary, '.nav-card-external': external,
    '.nav-card-copy > p': new Element(), '.nav-card-icon': icon, a: primary,
  };
  const result = fragment();
  result.selectors = card.selectors;
  result.append(card);
  return result;
}
const sites = [0, 1, 2, 3].map((index) => ({
  id: `site-${index}`, name: `官网 ${index}`, slug: `internal-${index}`, categorySlug: 'fun',
  url: `https://official-${index}.example/path?from=home&item=${index}`,
  desc: `简介 ${index}`, color: '#123abc', icon: null, mono: String(index),
}));
function render({ slugs = ['fun'], saved = null, storageBlocked = false, initialEvent, records = sites, selectedIndices = [2, 0, 3] } = {}) {
  const root = new Element();
  const viewport = { scrollY: 0 };
  const states = slugs.map((slug) => {
    const tabs = [new Element(), new Element()];
    tabs.forEach((tab, index) => {
      tab.dataset.homeTab = index === 0 ? 'all' : 'selected';
      tab.id = slug === 'fun' ? 'tab-' + index : slug + '-tab-' + index;
    });
    const list = new Element();
    // 模拟 SSR 首批，初始化不能替换或补齐现有卡片。
    records.slice(0, homeSections.HOME_SECTION_PAGE_SIZE).forEach((site) => {
      list.append(cloneCard());
      list.children.at(-1).dataset.siteId = site.id;
    });
    const initialCards = [...list.children];
    const status = new Element();
    const more = new Element();
    const panel = new Element();
    const section = new Element();
    section.id = slug;
    section.dataset.homeSection = slug;
    section.dataset.selectedTab = 'all';
    section.selectors = {
      '[data-home-sites]': list, '[data-home-panel]': panel,
      '[data-home-status]': status, '[data-home-tab]': tabs, '[data-home-more]': more,
    };
    section.getBoundingClientRect = () => ({
      top: 200 + root.querySelectorAll('[data-home-section]').indexOf(section) * 300 - viewport.scrollY,
    });
    section.scrollIntoView = (options) => {
      section.scrollOptions = options;
      viewport.scrollY += section.getBoundingClientRect().top - 100;
    };
    root.selectors['[data-home-section="' + slug + '"]'] = section;
    const anchor = new Element({ href: '/' + slug + '/' });
    anchor.dataset.homeAnchor = slug;
    return { tabs, list, status, more, panel, section, initialCards, anchor };
  });
  const data = new Element();
  data.textContent = JSON.stringify(slugs.map((slug) => ({
    slug, name: '趣味网站', sites: records,
    tabs: [{ key: 'all', label: '全部', indices: records.map((_, index) => index) },
      { key: 'selected', label: '精选', indices: selectedIndices }],
  })));
  const template = new Element();
  template.content = { cloneNode: cloneCard };
  root.selectors['[data-home-data]'] = data;
  root.selectors['[data-home-card]'] = template;
  // 刻意在分区前后及中间放非分区节点，检测排序是否误移动其他内容。
  const hero = new Element();
  const iconTemplate = new Element();
  root.append(hero, states[0].section, iconTemplate, ...states.slice(1).map((state) => state.section), template, data);
  const fixedNodes = root.children.map((node, index) => ({ node, index })).filter(({ node }) => !node.dataset.homeSection);
  const document = new Element();
  const home = new Element();
  document.selectors['[data-home-navigation]'] = root;
  document.selectors['[data-home-anchor]'] = states.map((state) => state.anchor);
  document.selectors['[data-home-start]'] = home;
  document.createDocumentFragment = fragment;
  document.createComment = () => new Element();
  document.documentElement = { classList: { remove() {} } };
  const window = new Element();
  window.scrollTo = ({ top }) => { viewport.scrollY = top; };
  const storage = new Map(saved === null ? [] : [[menuOrder.MENU_ORDER_KEY, saved]]);
  const storageReads = [];
  const frames = new Map();
  let nextFrame = 0;
  const location = new URL('https://nav.example/');
  const context = {
    exports: {}, document, window, AbortController, location, URL,
    history: { pushState(_state, _unused, url) { location.href = new URL(url, location).href; } },
    matchMedia: () => ({ matches: true }),
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame(id) { frames.delete(id); },
    require(name) {
      if (name === '../lib/menu-order.ts') return menuOrder;
      if (name === '../lib/home-sections') return homeSections;
      // 独立分类栏滚动不参与卡片/排序测试；保留初始化返回清理函数的真实契约。
      if (name === './homeTabs') return { initHomeTabs() { return () => {}; } };
      assert.equal(name, './site-icons.ts');
      return { appendSiteImage() {} }; // 隔离图片加载；卡片和排序均执行真实源码。
    },
  };
  Object.defineProperty(context, 'localStorage', { get() {
    if (storageBlocked) throw new Error('Storage denied');
    return { getItem(key) { storageReads.push(key); return storage.get(key) ?? null; } };
  } });
  const orderEvent = (detail) => document.dispatchEvent(new CustomEvent('nav:menu-order-change', { detail }));
  if (initialEvent) orderEvent(initialEvent);
  vm.runInNewContext(code, context, { timeout: 1000 });
  return {
    ...states[0], states, document, window, root, home, viewport, location, storage, storageReads, fixedNodes, orderEvent,
    order: () => root.querySelectorAll('[data-home-section]').map((section) => section.dataset.homeSection),
    flushFrames() { const pending = [...frames.values()]; frames.clear(); pending.forEach((callback) => callback()); },
  };
}
function assertCard(card, site) {
  assert.equal(card.dataset.siteId, site.id);
  for (const selector of ['.nav-card-detail', '.nav-card-external']) {
    const link = card.querySelector(selector);
    assert.equal(link.href, site.url, `${selector} 必须直达官网，不能回内部详情`);
    assert.equal(link.target, '_blank');
    const rel = new Set((link.rel ?? '').split(/\s+/));
    assert.ok(rel.has('noopener') && rel.has('noreferrer'));
    assert.equal(link.attributes['aria-label'], `直达 ${site.name} 官网（新窗口打开）`);
  }
  const primary = card.querySelector('.nav-card-detail');
  assert.equal(primary.textContent, site.name);
  assert.equal(primary.title, site.name);
  assert.equal(card.querySelector('[data-favorite-id]').dataset.favoriteId, site.id);
  assert.equal(card.querySelector('[data-favorite-id]').dataset.siteName, site.name);
  assert.equal(card.querySelector('.nav-card-copy > p').textContent, site.desc);
}

test('初始化保留服务端全部四个站点，不替换或截断卡片', () => {
  const state = render();
  assert.deepEqual(state.list.children, state.initialCards);
  assert.deepEqual(state.list.children.map((card) => card.dataset.siteId), sites.map((site) => site.id));
  assert.equal(state.status.textContent, '全部：共 4 个，已全部显示');
});

test('小于首批大小的标签完整显示并保留官网链接', () => {
  const state = render();
  state.tabs[1].dispatch('click');
  assert.equal(state.section.dataset.selectedTab, 'selected');
  assert.equal(state.panel.attributes['aria-labelledby'], 'tab-1');
  assert.equal(state.tabs[1].attributes['aria-selected'], 'true');
  assert.equal(state.tabs[0].attributes['aria-selected'], 'false');
  assert.equal(state.tabs[1].tabIndex, 0);
  assert.equal(state.tabs[0].tabIndex, -1);
  assert.deepEqual(state.list.children.map((card) => card.dataset.siteId), ['site-2', 'site-0', 'site-3']);
  [2, 0, 3].forEach((index, position) => assertCard(state.list.children[position], sites[index]));
  assert.equal(state.status.textContent, '精选：共 3 个，已全部显示');
  const cards = [...state.list.children];
  state.tabs[1].dispatch('click');
  assert.deepEqual(state.list.children, cards, '重复选择当前标签不能重建或追加卡片');
  state.tabs[0].dispatch('click');
  assert.equal(state.list.children.length, 4);
  sites.forEach((site, index) => assertCard(state.list.children[index], site));
  assert.equal(state.status.textContent, '全部：共 4 个，已全部显示');
});

test('键盘方向键及 Home/End 切换小标签并聚焦 Tab', () => {
  const state = render();
  for (const [from, key, target] of [
    [0, 'ArrowRight', 1], [1, 'Home', 0], [0, 'ArrowLeft', 1],
    [1, 'ArrowRight', 0], [0, 'End', 1], [1, 'ArrowLeft', 0],
  ]) {
    let prevented = false;
    state.tabs[from].dispatch('keydown', { key, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(state.tabs[target].focused, true);
    assert.equal(state.section.dataset.selectedTab, target ? 'selected' : 'all');
    const indices = target ? [2, 0, 3] : [0, 1, 2, 3];
    assert.equal(state.list.children.length, indices.length);
    indices.forEach((index, position) => assertCard(state.list.children[position], sites[index]));
  }
});

test('Astro 回访保留选择及全部卡片，离开后清理旧监听', () => {
  const state = render();
  state.tabs[1].dispatch('click');
  const cards = [...state.list.children];
  state.document.dispatch('astro:page-load');
  assert.deepEqual(state.list.children, cards);
  assert.equal(state.status.textContent, '精选：共 3 个，已全部显示');
  state.tabs[0].dispatch('click');
  assert.equal(state.list.children.length, 4);
  sites.forEach((site, index) => assertCard(state.list.children[index], site));
  state.tabs[1].dispatch('click');
  state.document.dispatch('astro:before-swap');
  state.tabs[0].dispatch('click');
  assert.equal(state.section.dataset.selectedTab, 'selected', '离开后旧监听不能继续修改卡片');
  assert.equal(state.list.children.length, 3);
});

const slugs = ['fun', 'ai', 'dev'];
const defaultOrder = ['/', '/fun/', '/ai/', '/dev/'];
const savedOrder = ['/', '/ai/', '/dev/', '/fun/'];
function assertFixedNodes(state) {
  for (const { node, index } of state.fixedNodes) {
    assert.equal(state.root.children[index], node, '不能移动 hero、模板或 JSON 等非分区节点');
  }
}
function assertActive(state, slug) {
  for (const { anchor } of state.states) {
    const selected = anchor.dataset.homeAnchor === slug;
    assert.equal(anchor.dataset.homeActive, String(selected));
    assert.equal(anchor.attributes['aria-current'], selected ? 'location' : undefined);
  }
  assert.equal(state.home.dataset.homeActive, String(!slug));
  assert.equal(state.home.attributes['aria-current'], slug ? undefined : 'page');
}

test('首次及刷新读取共享菜单存储，侧边栏先初始化或后发事件均恢复同一分区顺序', () => {
  for (const initialEvent of [undefined, savedOrder]) {
    const state = render({ slugs, saved: JSON.stringify(savedOrder), initialEvent });
    assert.deepEqual(state.order(), ['ai', 'dev', 'fun']);
    assert.deepEqual(state.storageReads, [menuOrder.MENU_ORDER_KEY]);
    state.states.forEach(({ list, initialCards }) => assert.deepEqual(list.children, initialCards));
    assertFixedNodes(state);
    state.orderEvent(savedOrder);
    assert.deepEqual(state.order(), ['ai', 'dev', 'fun']);
    assertFixedNodes(state);
  }
});

test('排序事件直接采用 href detail，存储陈旧或被禁用也同步且保留 tabs、全部卡片及节点', () => {
  for (const storageBlocked of [false, true]) {
    const state = render({ slugs, saved: JSON.stringify(defaultOrder), storageBlocked });
    state.tabs[1].dispatch('click');
    const cards = [...state.list.children];
    const sectionNodes = new Map(state.states.map(({ section }) => [section.dataset.homeSection, section]));
    const readsBeforeEvent = state.storageReads.length;
    state.orderEvent(['/', '/dev/', '/missing/', '/ai/', '/dev/', 42, '/fun/']);
    assert.deepEqual(state.order(), ['dev', 'ai', 'fun']);
    assert.equal(state.storageReads.length, readsBeforeEvent, '事件处理不能重新读取存储覆盖 detail');
    state.root.querySelectorAll('[data-home-section]').forEach((section) => {
      assert.equal(section, sectionNodes.get(section.dataset.homeSection));
    });
    assert.equal(state.section.dataset.selectedTab, 'selected');
    assert.equal(state.tabs[1].attributes['aria-selected'], 'true');
    assert.deepEqual(state.list.children, cards);
    assert.equal(state.status.textContent, '精选：共 3 个，已全部显示');
    assert.equal(state.list.children.length, 3, '排序后仍保留全部匹配卡片');
    assertCard(state.list.children[2], sites[3]);
    assertFixedNodes(state);
  }
});

test('取消拖拽与外部默认顺序事件恢复分区；Astro page-load 重新读取存储且无存储时恢复服务端默认', () => {
  const state = render({ slugs, saved: JSON.stringify(savedOrder) });
  state.tabs[1].dispatch('click');
  const cards = [...state.list.children];
  state.orderEvent(['/dev/', '/fun/', '/ai/']);
  state.orderEvent(savedOrder); // 取消拖拽时 apply 原顺序也发出同一事件。
  assert.deepEqual(state.order(), ['ai', 'dev', 'fun']);
  state.storage.delete(menuOrder.MENU_ORDER_KEY);
  state.orderEvent(defaultOrder); // 外部清除存储后广播默认菜单顺序，不依赖恢复按钮。
  assert.deepEqual(state.order(), slugs);
  state.storage.set(menuOrder.MENU_ORDER_KEY, JSON.stringify(['/dev/']));
  state.document.dispatch('astro:page-load');
  assert.deepEqual(state.order(), ['dev', 'fun', 'ai'], '缺失分区按服务端默认顺序补齐');
  assert.deepEqual(state.list.children, cards);
  state.storage.delete(menuOrder.MENU_ORDER_KEY);
  state.document.dispatch('astro:page-load');
  assert.deepEqual(state.order(), slugs, '不能把回访时已排序的 DOM 当作默认顺序');
  assert.equal(state.list.children.length, 3);
  state.orderEvent(savedOrder); // 其他标签页 storage 同步后由侧边栏广播。
  assert.deepEqual(state.order(), ['ai', 'dev', 'fun']);
  state.document.dispatch('astro:before-swap');
  state.orderEvent(defaultOrder);
  assert.deepEqual(state.order(), ['ai', 'dev', 'fun'], '离开页面后必须清理排序监听');
  assertFixedNodes(state);
});

test('损坏或无效存储回退默认分区顺序，部分顺序过滤非分区并补齐新增分区', () => {
  for (const saved of ['{broken', '{}', 'null', '42']) {
    assert.deepEqual(render({ slugs, saved }).order(), slugs);
  }
  const state = render({ slugs, saved: JSON.stringify(['/', '/dev/', '/unknown/', '/dev/']) });
  assert.deepEqual(state.order(), ['dev', 'fun', 'ai']);
  state.orderEvent([]);
  assert.deepEqual(state.order(), slugs);
});

test('排序后立即重算 active，滚动及锚点跳转按实际分区位置高亮，首页仍能回顶', () => {
  const state = render({ slugs });
  assertActive(state, '');
  state.viewport.scrollY = 450;
  state.window.dispatch('scroll');
  state.flushFrames();
  assertActive(state, 'ai');
  state.orderEvent(savedOrder);
  assertActive(state, 'dev'); // 原 elements 首项 fun 此时在视口下方，不能提前 break。
  state.viewport.scrollY = 750;
  state.window.dispatch('scroll');
  state.flushFrames();
  assertActive(state, 'fun'); // 多个分区经过阈值时必须选实际位置最近者。
  const ai = state.states.find(({ section }) => section.dataset.homeSection === 'ai');
  let prevented = 0;
  const click = { button: 0, preventDefault() { prevented++; } };
  ai.anchor.dispatch('click', { ...click, ctrlKey: true });
  assert.equal(prevented, 0, '保留修饰键打开分类页的行为');
  ai.anchor.dispatch('click', click);
  assert.equal(prevented, 1);
  assert.equal(state.location.hash, '#ai');
  assert.equal(ai.section.scrollOptions.block, 'start');
  assert.equal(ai.section.scrollOptions.behavior, 'instant');
  state.flushFrames();
  assertActive(state, 'ai');
  state.orderEvent(defaultOrder);
  assertActive(state, 'fun'); // 外部恢复默认顺序后也立即重算高亮。
  state.home.dispatch('click', click);
  assert.equal(state.location.hash, '');
  assert.equal(state.viewport.scrollY, 0);
  assertActive(state, '');
});

const manySites = Array.from({ length: 95 }, (_, index) => ({
  ...sites[index % sites.length], id: `batch-${index}`, name: `分批站点 ${index}`,
  url: `https://batch-${index}.example/`,
}));
const manyIndices = manySites.map((_, index) => index).reverse().slice(0, 79);

test('首屏及重复初始化仅18张，加载更多每次追加36张且不重复，尾批隐藏按钮', () => {
  const state = render({ records: manySites, selectedIndices: manyIndices });
  assert.equal(state.list.children.length, 18);
  assert.equal(state.status.textContent, '全部：共 95 个，已显示 18 个');
  assert.equal(state.more.hidden, false);
  state.document.dispatch('DOMContentLoaded');
  state.document.dispatch('astro:page-load');
  assert.deepEqual(state.list.children, state.initialCards);
  state.more.dispatch('click');
  assert.equal(state.list.children.length, 54, '回访不能重复绑定加载监听');
  assert.deepEqual(state.list.children.slice(0, 18), state.initialCards, '追加不能替换已有收藏/图标节点');
  state.list.children.slice(18).forEach((card, offset) => assertCard(card, manySites[offset + 18]));
  state.more.dispatch('click');
  assert.equal(state.list.children.length, 90);
  assert.equal(state.more.textContent, '加载更多（5 个）');
  state.more.dispatch('click');
  assert.equal(state.list.children.length, 95);
  assert.equal(state.more.hidden, true);
  assert.equal(state.status.textContent, '全部：共 95 个，已全部显示');
  state.more.dispatch('click');
  assert.deepEqual(state.list.children.map((card) => card.dataset.siteId), manySites.map((site) => site.id));
});

test('大标签切换重置为18张，分批顺序及链接正确，回访保持批次且离开清理监听', () => {
  const state = render({ slugs: ['fun', 'ai'], records: manySites, selectedIndices: manyIndices });
  state.more.dispatch('click');
  state.tabs[0].dispatch('keydown', { key: 'End', preventDefault() {} });
  assert.equal(state.tabs[1].focused, true);
  assert.equal(state.list.children.length, 18);
  assert.equal(state.status.textContent, '精选：共 79 个，已显示 18 个');
  state.more.dispatch('click');
  assert.equal(state.list.children.length, 54);
  const cards = [...state.list.children];
  state.document.dispatch('astro:page-load');
  assert.deepEqual(state.list.children, cards);
  state.more.dispatch('click');
  assert.equal(state.list.children.length, 79);
  manyIndices.forEach((index, position) => assertCard(state.list.children[position], manySites[index]));
  assert.equal(state.more.hidden, true);
  state.tabs[0].dispatch('click');
  assert.equal(state.list.children.length, 18);
  assert.equal(state.more.hidden, false);
  state.list.children.forEach((card, index) => assertCard(card, manySites[index]));
  assert.deepEqual(state.states[1].list.children, state.states[1].initialCards, '操作不影响其他分区');
  state.document.dispatch('astro:before-swap');
  state.more.dispatch('click');
  assert.equal(state.list.children.length, 18);
});

test('加载及切换改变分区高度时主动刷新锚点高亮，不等待用户滚动', () => {
  const state = render({ slugs: ['fun', 'ai'], records: manySites, selectedIndices: manyIndices });
  state.viewport.scrollY = 450;
  state.window.dispatch('scroll');
  state.flushFrames();
  assertActive(state, 'ai');
  // 模拟前一分区追加卡片，把下一分区推离激活线。
  state.states[1].section.getBoundingClientRect = () => ({ top: 800 });
  state.more.dispatch('click');
  state.flushFrames();
  assertActive(state, 'fun');
  state.states[1].section.getBoundingClientRect = () => ({ top: 50 });
  state.tabs[1].dispatch('click');
  state.flushFrames();
  assertActive(state, 'ai');
});
