import { bindAdminPagination } from './admin-pagination';
import type { MenuSeedItem } from '../server/menu-seed';
import { curatedFields, curatedPayloadError, mergeCuratedFields, safeCuratedHref, type CuratedField } from '../lib/curated-menu-fields';

type Snapshot = { menus: MenuSeedItem[]; revision: string; writable: boolean };
const locations: Record<string, string> = { sidebar: '侧边栏', 'sidebar-footer': '侧边栏底部', topbar: '顶部导航', 'topbar-actions': '顶部操作区' };
const kinds: Record<string, string> = { link: '链接', category: '分类', group: '分组', resource: '资源' };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const safeHref = (href: string) => safeCuratedHref(href, true);
function parseSnapshot(value: unknown): Snapshot {
  if (!isObject(value) || !isObject(value.data)) throw new Error('服务器返回了无效的菜单数据。');
  const d = value.data;
  if (!Array.isArray(d.menus) || typeof d.revision !== 'string' || !d.revision || typeof d.writable !== 'boolean') throw new Error('菜单响应缺少版本或写入状态。');
  for (const m of d.menus) {
    if (!isObject(m) || !['id', 'label', 'location', 'kind'].every(k => typeof m[k] === 'string')
      || !(m.parentId === null || typeof m.parentId === 'string') || !(m.href === null || typeof m.href === 'string')
      || !(m.icon === null || typeof m.icon === 'string') || !Number.isSafeInteger(m.sortOrder)
      || typeof m.enabled !== 'boolean' || !isObject(m.payload)) throw new Error('菜单数据格式不正确。');
  }
  return d as Snapshot;
}
function validate(menus: MenuSeedItem[], categories: Map<string, string | null>) {
  if (menus.length > 500) throw new Error('整份菜单最多允许 500 项，请删除多余菜单后再保存。');
  const ids = new Set<string>();
  for (const m of menus) {
    const fail = (message: string): never => { throw new Error(`「${m.label || m.id}」：${message}`); };
    if (!/^[a-zA-Z0-9:/_.-]{1,191}$/.test(m.id) || ids.has(m.id)) fail('菜单 ID 必须唯一，最长 191 字符，仅允许字母、数字及 : / _ . -。');
    ids.add(m.id);
    if (!m.label.trim()) fail('请输入名称。');
    if (!Object.hasOwn(locations, m.location) || !Object.hasOwn(kinds, m.kind)) fail('区域或类型不受支持。');
    if (!Number.isSafeInteger(m.sortOrder) || m.sortOrder < 0 || m.sortOrder > 1000000) fail('默认排序必须是 0–1000000 的整数。');
    if (m.icon !== null && !/^lucide:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(m.icon)) fail('图标必须是 lucide 名称或留空。');
    if (m.location === 'sidebar' && !['link', 'category'].includes(m.kind)) fail('侧边栏只允许链接和分类。');
    if (m.kind === 'group') { if (m.href !== null || m.parentId !== null) fail('分组必须在根级且无链接。'); }
    else if (typeof m.href !== 'string' || !safeHref(m.href)) fail('请输入 / 开头的站内路径或 HTTP(S) 链接，锚点请使用 /#anchor。');
    if (m.kind === 'category' && (m.location !== 'sidebar' || !categories.has(m.id) || categories.get(m.id) !== m.href)) fail('分类仅能保留已读取的侧边栏分类锚点。');
    if (m.parentId !== null) {
      const parent = menus.find(p => p.id === m.parentId);
      if (!parent || parent.id === m.id || parent.kind !== 'group' || parent.parentId !== null || parent.location !== m.location) fail('父级必须是同一区域的根分组。');
    }
    if (m.kind === 'resource' && (m.location !== 'topbar' || m.parentId === null)) fail('精选资源必须放在顶部导航的分组内。');
    if (!isObject(m.payload)) fail('payload 必须是 JSON 对象。');
    const curatedError = curatedPayloadError(m.payload);
    if (curatedError) fail(curatedError);
    if ('target' in m.payload && !['_blank', '_self'].includes(String(m.payload.target))) fail('payload.target 只能是 _blank 或 _self。');
  }
}
let mounted: HTMLElement | null = null;
let dispose: (() => void) | undefined;
function initMenus() {
  const root = document.querySelector<HTMLElement>('[data-menu-admin]');
  if (root && root === mounted) return;
  dispose?.();
  if (!root) return;
  mounted = root;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => root.querySelector<T>(`#menu-${id}`)!;
  const input = (id: string) => el<HTMLInputElement>(id);
  const select = (id: string) => el<HTMLSelectElement>(id);
  const editor = el<HTMLFormElement>('editor');
  const dialog = el<HTMLDialogElement>('dialog');
  let filters = { name: '', location: '', visible: '' };
  const editedCuratedFields = new Set<CuratedField>();
  const events = new AbortController();
  let requests = new AbortController();
  let revision = '', selected = '', baseline = '[]';
  let menus: MenuSeedItem[] = [];
  let categories = new Map<string, string | null>();
  let writable = false, busy = false, saving = false, conflict = false, formDirty = false, alive = true;
  let loggingOut = false, retrySave = false;
  let page = 1, pageSize = 10, total = 0, totalPages = 1;
  const pagination = bindAdminPagination(el('pagination'), (nextPage: number) => {
    if (busy) return;
    page = Math.max(1, Math.min(totalPages, Math.trunc(nextPage) || 1)); renderList();
  });
  const dirty = () => formDirty || JSON.stringify(menus) !== baseline;
  const say = (message: string) => { el('status').textContent = message; if (dialog.open) el('form-status').textContent = message; };
  function controls() {
    pagination.update({ page, totalPages, total, pageSize, busy });
    el<HTMLButtonElement>('prev').disabled = busy || page <= 1;
    el<HTMLButtonElement>('next').disabled = busy || page >= totalPages;
    select('page-size').disabled = busy;
    el('loading').hidden = !busy;
    el<HTMLButtonElement>('logout').disabled = busy;
    el<HTMLButtonElement>('retry').disabled = busy;
    el('reload').textContent = busy && !saving ? '正在加载…' : '重新加载';
    el('save').textContent = busy && saving ? '正在保存…' : '保存全部';
    el<HTMLButtonElement>('reload').disabled = busy;
    for (const id of ['add', 'add-group', 'add-resource']) el<HTMLButtonElement>(id).disabled = busy || !writable || conflict;
    el<HTMLButtonElement>('save').disabled = busy || !writable || conflict || !dirty();
    el<HTMLFieldSetElement>('fields').disabled = busy || !writable || conflict;
    for (const id of ['close', 'cancel']) el<HTMLButtonElement>(id).disabled = busy;
    for (const button of el('list').querySelectorAll<HTMLButtonElement>('button')) button.disabled = busy || !writable || conflict;
    el('conflict').hidden = !conflict;
    el('dirty').textContent = dirty() ? '有未保存修改' : '';
    el('workspace').setAttribute('aria-busy', String(busy));
  }
  function parents() {
    const value = select('parent').value;
    select('parent').replaceChildren(new Option('根菜单', ''));
    menus.filter(m => m.id !== selected && m.kind === 'group' && m.parentId === null && m.location === select('location').value)
      .forEach(m => select('parent').add(new Option(m.label, m.id)));
    select('parent').value = Array.from(select('parent').options).some(o => o.value === value) ? value : '';
    const group = select('kind').value === 'group';
    select('parent').disabled = group;
    if (group) select('parent').value = '';
    input('href').disabled = group || select('kind').value === 'category';
    if (group) input('href').value = '';
    input('href').required = !group;
    el('curated').hidden = !['group', 'resource'].includes(select('kind').value);
    el('resource-fields').hidden = select('kind').value !== 'resource';
  }
  function showEditor() {
    const m = menus.find(m => m.id === selected);
    editor.hidden = !m; el('empty').hidden = !!m;
    formDirty = false; editedCuratedFields.clear();
    if (!m) { editor.reset(); controls(); return; }
    for (const key of ['id', 'label', 'href', 'icon'] as const) input(key).value = m[key] ?? '';
    select('location').value = m.location; select('kind').value = m.kind;
    select('kind').disabled = m.kind === 'category';
    select('location').disabled = m.kind === 'category';
    input('order').value = String(m.sortOrder); input('enabled').checked = m.enabled;
    el<HTMLTextAreaElement>('payload').value = JSON.stringify(m.payload, null, 2);
    for (const key of curatedFields) el<HTMLInputElement | HTMLTextAreaElement>(key).value = typeof m.payload[key] === 'string' ? m.payload[key] as string : '';
    parents(); select('parent').value = m.parentId ?? '';
    controls();
  }
  function closeEditor() {
    if (busy || (formDirty && !confirm('关闭将丢弃当前表单尚未应用的修改，已应用及新增的草稿仍保留，是否继续？'))) return;
    showEditor(); dialog.close();
  }
  function openEditor() {
    showEditor(); el('form-status').textContent = '';
    if (!dialog.open) dialog.showModal();
    input('label').focus();
  }
  function renderList() {
    const list = el('list'); list.replaceChildren();
    const sorted = [...menus].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
    const visibleState = (m: MenuSeedItem) => !m.enabled ? 'disabled'
      : m.parentId && !menus.find(p => p.id === m.parentId)?.enabled ? 'parent-hidden' : 'enabled';
    const filtered = sorted.filter(m => (!filters.location || filters.location === m.location)
      && m.label.toLocaleLowerCase().includes(filters.name) && (!filters.visible || filters.visible === visibleState(m)));
    total = filtered.length; totalPages = Math.max(1, Math.ceil(total / pageSize)); page = Math.min(page, totalPages);
    let count = 0;
    for (const m of filtered.slice((page - 1) * pageSize, page * pageSize)) {
      const parent = menus.find(p => p.id === m.parentId);
      const state = visibleState(m);
      const row = document.createElement('tr');
      for (const text of [m.label, locations[m.location], kinds[m.kind], parent?.label ?? '根菜单', String(m.sortOrder),
        state === 'enabled' ? '显示' : state === 'disabled' ? '隐藏' : '随父级隐藏']) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      const actions = document.createElement('td'); actions.className = 'content-actions';
      for (const [action, label] of [['edit', '编辑'], ['delete', '删除']]) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.id = m.id;
        button.dataset.action = action; button.textContent = label;
        if (action === 'delete') button.className = 'danger';
        actions.append(button);
      }
      row.append(actions); list.append(row); count++;
    }
    if (!count) {
      const row = document.createElement('tr'), cell = document.createElement('td');
      cell.colSpan = 7; cell.className = 'content-empty'; cell.textContent = '无数据'; row.append(cell); list.append(row);
    }
    el('summary').textContent = `共 ${menus.length} 项，筛选结果 ${total} 项`;
    el('page-summary').textContent = `共 ${total} 项，第 ${page} / ${totalPages} 页`;
    controls();
  }
  function applyForm() {
    if (!formDirty) return true;
    if (!editor.reportValidity()) return false;
    const old = menus.find(m => m.id === selected);
    if (!old) return false;
    try {
      let payload: unknown = JSON.parse(el<HTMLTextAreaElement>('payload').value);
      if (!isObject(payload)) throw new Error('payload 必须是 JSON 对象，不能是数组或 null。');
      const edits: Partial<Record<CuratedField, string>> = {};
      for (const key of editedCuratedFields) edits[key] = el<HTMLInputElement | HTMLTextAreaElement>(key).value;
      payload = mergeCuratedFields(payload, edits);
      const m: MenuSeedItem = { ...old, label: input('label').value.trim(), location: select('location').value,
        kind: select('kind').value, href: select('kind').value === 'group' ? null : input('href').value.trim(),
        icon: input('icon').value.trim() || null, parentId: select('kind').value === 'group' ? null : select('parent').value || null,
        sortOrder: Number(input('order').value), enabled: input('enabled').checked, payload: payload as MenuSeedItem['payload'] };
      const children = menus.filter(p => p.parentId === old.id);
      if (children.length && m.kind !== 'group') throw new Error('此分组仍有子菜单，请先移动或删除子菜单再修改类型。');
      const next = menus.map(p => p.id === m.id ? m : p.parentId === m.id ? { ...p, location: m.location } : p);
      validate(next, categories);
      menus = next; showEditor(); renderList(); return true;
    } catch (error) { say(error instanceof Error ? error.message : '表单内容无效。'); return false; }
  }
  function reset() {
    requests.abort(); requests = new AbortController();
    revision = ''; selected = ''; baseline = '[]'; menus = []; categories.clear();
    writable = false; busy = false; saving = false; conflict = false; formDirty = false;
    page = 1; total = 0; totalPages = 1;
    dialog.close(); editor.reset(); el('list').replaceChildren();
    el('workspace').hidden = true; el('logout').hidden = true;
    controls();
  }
  async function load(save = false) {
    if (busy || (save && (!writable || conflict || !dirty()))) return;
    if (save && !applyForm()) return;
    let requestBody: string | undefined;
    if (!save && dirty() && !confirm('重新加载将丢弃当前全部草稿与表单修改，是否继续？')) return;
    if (save) {
      try {
        validate(menus, categories);
        requestBody = JSON.stringify({ menus, revision });
        if (new TextEncoder().encode(requestBody).byteLength > 512 * 1024) throw new Error('整份请求超过 512 KiB，请精简菜单或 payload 后再保存。');
      } catch (error) { say((error as Error).message); return; }
      if (!confirm(`确认一次提交全部 ${menus.length} 项菜单？新增、修改、隐藏和删除将一起生效。`)) return;
    }
    el('retry').hidden = true;
    saving = save; busy = true; controls(); say(save ? '正在保存全部菜单，请稍候…' : '正在验证并读取菜单…');
    const signal = requests.signal;
    try {
      const response = await fetch('/api/admin/menus', { method: save ? 'PUT' : 'GET', signal, cache: 'no-store', redirect: 'error',
        headers: save ? { 'Content-Type': 'application/json' } : {},
        ...(save ? { body: requestBody } : {}) });
      if (!alive || signal.aborted) return;
      if (response.status === 409) { conflict = true; throw new Error('版本冲突：请重新加载最新菜单后再编辑；本页草稿未覆盖服务器。'); }
      if (response.status === 401) throw new Error('登录已失效，草稿仍保留在本页。请在新标签页登录后重试；离开本页将丢失未保存修改。');
      const body: unknown = await response.json().catch(() => {
        throw new Error(`服务器响应无法解析（HTTP ${response.status}），请稍后重试。`);
      });
      if (!alive || signal.aborted) return;
      if (!response.ok) {
        const error = isObject(body) && isObject(body.error) ? body.error : null;
        throw new Error(error && typeof error.message === 'string' ? `${typeof error.code === 'string' ? `[${error.code}] ` : ''}${error.message}` : `请求失败（${response.status}）。`);
      }
      const snapshot = parseSnapshot(body);
      const anchors = new Map(snapshot.menus.filter(m => m.kind === 'category').map(m => [m.id, m.href]));
      validate(snapshot.menus, anchors);
      menus = clone(snapshot.menus); revision = snapshot.revision; writable = snapshot.writable; categories = anchors;
      baseline = JSON.stringify(menus); conflict = false;
      selected = menus.some(m => m.id === selected) ? selected : menus[0]?.id ?? '';
      el('workspace').hidden = false; el('logout').hidden = false;
      el('mode').textContent = writable ? '' : '只读模式，无法编辑或保存';
      dialog.close(); renderList(); showEditor(); say(save ? '全部菜单已保存，版本已更新。' : '');
    } catch (error) {
      if (alive && !signal.aborted) {
        retrySave = save && !conflict;
        el('retry').textContent = retrySave ? '重试保存' : '重试加载';
        say(`${save ? '保存未确认成功，草稿仍保留。' : '加载失败。'}${error instanceof Error ? error.message : '网络请求失败，请重试。'}`);
        el('retry').hidden = false;
      }
    } finally { if (alive && !signal.aborted) { busy = false; controls(); } }
  }
  const on = (id: string, event: string, handler: (event: Event) => void) => el(id).addEventListener(event, handler, { signal: events.signal });
  on('logout', 'click', async () => {
    if (busy) return;
    if (dirty() && !confirm('退出将丢弃全部未保存草稿，是否继续？')) return;
    loggingOut = true; busy = true; controls();
    try {
      const response = await fetch('/api/admin/session', { method: 'DELETE', signal: requests.signal });
      if (!alive || requests.signal.aborted) return;
      if (!response.ok) throw new Error();
      loggingOut = false; reset(); window.location.replace('/admin/login/');
    } catch { if (alive) say('退出失败，草稿仍保留，请重试。'); }
    finally { if (alive) { loggingOut = false; busy = false; controls(); } }
  });
  on('retry', 'click', () => void load(retrySave));
  on('reload', 'click', () => void load());
  on('save', 'click', () => void load(true));
  on('query', 'submit', event => {
    event.preventDefault(); if (busy) return;
    page = 1; filters = { name: input('name').value.trim().toLocaleLowerCase(), location: select('filter').value, visible: select('visible').value }; renderList();
  });
  on('query-reset', 'click', () => {
    if (busy) return;
    input('name').value = ''; select('filter').value = ''; select('visible').value = '';
    page = 1; filters = { name: '', location: '', visible: '' }; renderList();
  });
  on('prev', 'click', () => { if (!busy && page > 1) { page--; renderList(); } });
  on('next', 'click', () => { if (!busy && page < totalPages) { page++; renderList(); } });
  on('page-size', 'change', () => {
    if (busy) return;
    select('page-size').value = '10'; pageSize = 10; page = 1; renderList();
  });
  on('close', 'click', closeEditor); on('cancel', 'click', closeEditor);
  on('dialog', 'cancel', event => { event.preventDefault(); closeEditor(); });
  for (const key of curatedFields) {
    const mark = () => editedCuratedFields.add(key);
    on(key, 'input', mark); on(key, 'change', mark);
  }
  on('editor', 'input', () => { formDirty = true; controls(); });
  on('editor', 'change', () => { formDirty = true; controls(); });
  on('location', 'change', parents); on('kind', 'change', parents);
  on('editor', 'submit', event => { event.preventDefault(); if (!busy && writable && !conflict && applyForm()) { dialog.close(); say('已应用到本页草稿；请点击「保存全部」提交。'); } });
  on('revert', 'click', () => { if (!busy && (!formDirty || confirm('撤销当前表单中尚未应用的修改？'))) showEditor(); });
  on('list', 'click', event => {
    const button = (event.target as Element).closest<HTMLButtonElement>('button[data-id]');
    if (!button || busy || !writable || conflict) return;
    if (button.dataset.action === 'delete') { deleteMenu(button.dataset.id!); return; }
    if (formDirty && !confirm('当前表单尚未应用，切换将丢弃这些修改，是否继续？')) return;
    selected = button.dataset.id!; openEditor();
  });
  function addMenu(kind = 'link') {
    if (busy || !writable || conflict || !applyForm()) return;
    if (menus.length >= 500) { say('最多允许 500 项菜单，无法继续新增。'); return; }
    const parent = kind === 'resource' ? menus.find(m => m.id === selected && m.location === 'topbar' && m.kind === 'group')
      ?? menus.find(m => m.id === menus.find(row => row.id === selected)?.parentId && m.location === 'topbar' && m.kind === 'group')
      ?? menus.find(m => m.location === 'topbar' && m.kind === 'group') : undefined;
    if (kind === 'resource' && !parent) { say('请先新增并应用一个顶部精选分组，再新增资源。'); return; }
    const location = kind === 'link' ? filters.location || 'topbar' : 'topbar';
    const order = Math.min(1000000, Math.max(-1, ...menus.filter(m => m.location === location && m.parentId === (parent?.id ?? null)).map(m => m.sortOrder)) + 1);
    const item: MenuSeedItem = { id: `menu:${crypto.randomUUID()}`, label: kind === 'group' ? '新精选分组' : kind === 'resource' ? '新精选资源' : '新菜单', location, kind, href: kind === 'group' ? null : '/', icon: null, parentId: parent?.id ?? null, sortOrder: order, enabled: false, payload: {} };
    menus.push(item); selected = item.id; openEditor(); renderList(); say('已新增隐藏菜单，尚未保存。');
  }
  on('add', 'click', () => addMenu());
  on('add-group', 'click', () => addMenu('group'));
  on('add-resource', 'click', () => addMenu('resource'));
  function deleteMenu(id: string) {
    if (busy || !writable || conflict) return;
    const item = menus.find(m => m.id === id); if (!item) return;
    const children = menus.filter(m => m.parentId === id);
    if (!confirm(`删除「${item.label}」${item.kind === 'group' ? `及其 ${children.length} 个子菜单` : ''}？当前表单修改也将丢弃。保存全部后才会生效。`)) return;
    menus = menus.filter(m => m.id !== id && m.parentId !== id);
    dialog.close(); selected = menus[0]?.id ?? ''; showEditor(); renderList(); say('已从草稿删除；保存全部后生效。');
  }
  on('delete', 'click', () => deleteMenu(selected));
  // 独立布局使用整页导航；returnValue 为旧浏览器保留离开确认兼容。
  window.addEventListener('beforeunload', event => { if (dirty() || loggingOut) { event.preventDefault(); event.returnValue = ''; } }, { signal: events.signal });
  dispose = () => { alive = false; reset(); pagination.destroy(); events.abort(); mounted = null; dispose = undefined; };
  document.addEventListener('astro:before-swap', () => dispose?.(), { signal: events.signal });
  window.addEventListener('pagehide', () => dispose?.(), { signal: events.signal });
  reset();
  void load();
}
// 导航入口仅注册一次；页面级监听和请求在离开时统一取消，BFCache 返回也重新验证。
document.addEventListener('astro:page-load', initMenus);
window.addEventListener('pageshow', event => { if (event.persisted) initMenus(); });
initMenus();




