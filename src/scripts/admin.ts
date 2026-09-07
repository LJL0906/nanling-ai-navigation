import { bindAdminPagination } from './admin-pagination';
import type { UnifiedSite, UnifiedCategory } from '../lib/navigation-types';

type Kind = 'sites' | 'categories';
type Revision = string | number;
type Site = UnifiedSite & { sortOrder: number; revision: Revision };
type Category = UnifiedCategory & { revision: Revision };
type Item = Site | Category;
type Snapshot = { items: Item[]; writable: boolean };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const message = (error: unknown) => error instanceof Error ? error.message : '操作失败，请重试。';
const mounted = new WeakSet<HTMLElement>();
const reservedSlugs = new Set(['admin', 'api', 'login', 'register', 'categories', 'search', 'tags', 'articles', 'favorites', 'history', 'settings', 'notifications', 'quick-search', 'entertainment', 'discover', '404']);
const validCount = (value: number) => Number.isSafeInteger(value) && value >= 0;

function snapshot(value: unknown, kind: Kind): Snapshot {
  if (!object(value) || !object(value.data) || !Array.isArray(value.data.items) || typeof value.data.writable !== 'boolean') {
    throw new Error('接口响应格式错误：缺少 items 或 writable。');
  }
  for (const item of value.data.items) {
    if (!object(item) || !['id', 'name', 'slug'].every(key => typeof item[key] === 'string')
      || !(typeof item.revision === 'string' || (typeof item.revision === 'number' && Number.isFinite(item.revision)))) {
      throw new Error('接口数据缺少有效标识或 revision，请刷新重试。');
    }
    if (kind === 'sites' && (!['url', 'category', 'description'].every(key => typeof item[key] === 'string')
      || !Array.isArray(item.tags) || !item.tags.every(tag => typeof tag === 'string') || !Number.isSafeInteger(item.sortOrder))) {
      throw new Error('站点字段格式不正确。');
    }
    if (kind === 'categories' && (!['color', 'icon'].every(key => typeof item[key] === 'string') || !Number.isSafeInteger(item.order))) {
      throw new Error('分类字段格式不正确。');
    }
  }
  return value.data as Snapshot;
}

export function initContent(kind: Kind) {
  const root = document.querySelector<HTMLElement>(kind === 'sites' ? '[data-admin-root]' : '[data-category-admin-root]');
  if (!root || mounted.has(root)) return;
  mounted.add(root);
  const el = <T extends HTMLElement = HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const query = el<HTMLInputElement>('[data-admin-query]');
  const filter = root.querySelector<HTMLSelectElement>('[data-admin-category]');
  const verification = root.querySelector<HTMLSelectElement>('[data-admin-verification]');
  const pageSizeSelect = el<HTMLSelectElement>('[data-admin-page-size]');
  const detailsDialog = el<HTMLDialogElement>('[data-content-details-dialog]');
  const rows = el<HTMLTableSectionElement>(kind === 'sites' ? '[data-admin-sites]' : '[data-content-items]');
  const errorBox = el('[data-content-error]');
  const formError = el('[data-content-form-error]');
  const dialog = el<HTMLDialogElement>('[data-content-dialog]');
  const form = el<HTMLFormElement>('[data-content-form]');
  const fields = el<HTMLFieldSetElement>('[data-content-fields]');
  const add = el<HTMLButtonElement>('[data-content-add]');
  const refresh = el<HTMLButtonElement>('[data-content-refresh]');
  const save = el<HTMLButtonElement>('[data-content-save]');
  const cancels = root.querySelectorAll<HTMLButtonElement>('[data-content-cancel]');
  const prev = el<HTMLButtonElement>('[data-admin-prev]');
  const next = el<HTMLButtonElement>('[data-admin-next]');
  const events = new AbortController();
  const requests = new AbortController();
  const options = { signal: events.signal };
  const label = kind === 'sites' ? '站点' : '分类';
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  let items: Item[] = [], categories: Category[] = [], sites: Site[] = [];
  let writable = false, loading = false, submitting = false, page = 1;
  let selected: Item | null = null;
  let pageSize = 10;
  let applied = { query: '', category: '', verification: '' };
  const pagination = bindAdminPagination(el('.admin-pagination'), target => {
    if (loading || submitting) return;
    page = target; render();
  });
  const verificationLabels: Record<string, string> = { unverified: '未验证', online: '在线', offline: '离线', redirect: '重定向', blocked: '受限', active: '有效', 'pending-review': '待审核' };
  const status = (site: Site) => site.verification?.status ?? 'unverified';
  const statusLabel = (site: Site) => verificationLabels[status(site)] ?? '未知';
  const categoryCount = (category: Category) => validCount(category.count) ? category.count : sites.filter(site => site.category === category.id).length;
  let baseline = '';
  const draft = () => JSON.stringify(Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]'), input => [input.name, input.value]));
  const dirty = () => dialog.open && draft() !== baseline;
  const iconNames = new Set(Array.from(root.querySelectorAll<HTMLOptionElement>('#content-icons option'), option => option.value));
  function closeEditor() {
    if (submitting || (dirty() && !window.confirm('表单有未保存的更改，确定放弃草稿并关闭吗？'))) return;
    dialog.close();
  }
  function showError(target: HTMLElement, text = '') { target.textContent = text; target.hidden = !text; }
  async function request(target: Kind, method = 'GET', body?: unknown): Promise<unknown> {
    const url = method === 'GET' ? `/api/admin/content?kind=${target}` : '/api/admin/content';
    const response = await fetch(url, {
      method, credentials: 'same-origin', cache: 'no-store', signal: requests.signal,
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      root?.querySelectorAll<HTMLElement>('[data-content-login]').forEach(link => { link.hidden = false; });
      throw new Error('登录已过期，草稿仍保留。请在新标签页登录，再返回此页重试；不要刷新当前页面。');
    }
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = object(result) && (typeof result.error === 'string' ? result.error
        : object(result.error) && typeof result.error.message === 'string' ? result.error.message
        : typeof result.message === 'string' ? result.message : '');
      const hint = response.status === 409 ? '数据已变更或存在关联，请刷新后重试；分类有关联站点时不能删除。'
        : response.status === 403 ? '当前数据源只读或无写入权限。' : `请求失败（${response.status}）。`;
      throw new Error(detail ? `${detail}\n${hint}` : hint);
    }
    return result;
  }
  function option(select: HTMLSelectElement, value: string, text: string) {
    const element = document.createElement('option'); element.value = value; element.textContent = text; select.append(element);
  }
  function updateCategories() {
    if (!filter) return;
    const current = filter.value;
    filter.replaceChildren(); option(filter, '', '全部分类');
    const select = control('category') as HTMLSelectElement;
    select.replaceChildren(); option(select, '', '请选择分类');
    for (const category of categories) { option(filter, category.id, category.name); option(select, category.id, category.name); }
    if (current && !categories.some(category => category.id === current)) option(filter, current, `未找到分类（${current}）`);
    filter.value = current;
  }
  function cell(row: HTMLTableRowElement, text: string, secondary?: string) {
    const td = document.createElement('td'); td.textContent = text;
    if (secondary) { const small = document.createElement('span'); small.className = 'content-secondary'; small.textContent = secondary; td.append(small); }
    row.append(td); return td;
  }
  function render() {
    const busy = loading || submitting;
    const q = applied.query;
    const filtered = items.filter(item => {
      const text = kind === 'sites' ? [item.name, item.slug, (item as Site).url, (item as Site).description, ...(item as Site).tags].join(' ') : `${item.name} ${item.slug}`;
      return text.toLocaleLowerCase().includes(q) && (!applied.category || (item as Site).category === applied.category)
        && (!applied.verification || status(item as Site) === applied.verification);
    });
    const pages = Math.max(1, Math.ceil(filtered.length / pageSize)); page = Math.min(page, pages);
    rows.replaceChildren();
    const names = new Map(categories.map(category => [category.id, category.name]));
    let index = (page - 1) * pageSize;
    for (const item of filtered.slice((page - 1) * pageSize, page * pageSize)) {
      const row = document.createElement('tr'); cell(row, String(++index)).className = 'admin-col-index';
      const name = cell(row, item.name); name.className = 'admin-col-name admin-ellipsis'; name.title = item.name;
      if (kind === 'sites') {
        const site = item as Site;
        const url = cell(row, site.url); url.className = 'admin-ellipsis'; url.title = site.url;
        const categoryName = names.get(site.category) ?? site.category;
        const categoryCell = cell(row, categoryName); categoryCell.className = 'admin-ellipsis'; categoryCell.title = categoryName;
        const tags = cell(row, site.tags.join('、') || '—'); tags.className = 'admin-ellipsis'; tags.title = site.tags.join('、');
        cell(row, statusLabel(site)); cell(row, String(site.sortOrder)).className = 'admin-col-order';
      } else {
        const category = item as Category;
        cell(row, String(categoryCount(category))); cell(row, String(category.order)).className = 'admin-col-order';
      }
      const actions = cell(row, ''); actions.className = 'admin-col-actions'; const wrap = document.createElement('div'); wrap.className = 'content-actions';
      for (const action of ['details', 'edit', 'delete'] as const) {
        const button = document.createElement('button'); button.type = 'button'; button.dataset.action = action; button.dataset.id = item.id;
        button.textContent = action === 'details' ? '详情' : action === 'edit' ? '编辑' : '删除'; button.setAttribute('aria-label', `${button.textContent}${item.name}`);
        if (action === 'delete') button.className = 'content-danger';
        button.disabled = busy || (action !== 'details' && !writable); wrap.append(button);
      }
      actions.append(wrap); rows.append(row);
    }
    if (!filtered.length) {
      const row = document.createElement('tr'); const td = cell(row, loading ? '正在加载…' : '无数据'); td.colSpan = kind === 'sites' ? 8 : 5; td.className = 'content-empty'; rows.append(row);
    }
    el('[data-content-pagination]').textContent = `共 ${filtered.length} 条 · 第 ${page} / ${pages} 页 · 每页 ${pageSize} 条`;
    pagination.update({ page, totalPages: pages, total: filtered.length, pageSize, busy });
    prev.disabled = busy || page <= 1; next.disabled = busy || page >= pages;
    add.disabled = !writable || busy; refresh.disabled = busy;
    refresh.textContent = loading ? '加载中…' : '刷新';
    add.title = !loading && !writable ? '当前数据源不可写' : '';
    fields.disabled = submitting; save.disabled = submitting || !writable; cancels.forEach(cancel => { cancel.disabled = submitting; });
    pageSizeSelect.disabled = busy;
    save.textContent = submitting ? '保存中…' : '保存';
    rows.closest('.admin-table-wrap')?.setAttribute('aria-busy', String(busy));
  }
  async function load() {
    if (loading) return;
    loading = true; writable = false; showError(errorBox); render();
    try {
      const [siteData, categoryData] = await Promise.all([
        kind === 'sites' ? request('sites').then(value => snapshot(value, 'sites')) : Promise.resolve(null),
        request('categories').then(value => snapshot(value, 'categories')),
      ]);
      if (requests.signal.aborted) return;
      // 分类 count 来自同一次后端快照；仅旧响应缺少计数时回退到站点统计。
      const fallback = kind === 'categories' && categoryData.items.some(item => !validCount((item as Category).count))
        ? snapshot(await request('sites'), 'sites') : null;
      if (requests.signal.aborted) return;
      sites = (siteData?.items ?? fallback?.items ?? []) as Site[];
      categories = (categoryData.items as Category[]).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-CN'));
      items = kind === 'sites' ? [...sites].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh-CN')) : categories;
      writable = (kind === 'sites' ? siteData : categoryData)?.writable === true;
      updateCategories();
    } catch (error) {
      if (!requests.signal.aborted) { showError(errorBox, `${message(error)}\n刷新失败，写入已禁用，请重试。`); }
    } finally { loading = false; if (!requests.signal.aborted) render(); }
  }
  function openEditor(item: Item | null) {
    if (!writable || loading || submitting) return;
    selected = item; form.reset(); showError(formError);
    el('[data-content-title]').textContent = `${item ? '编辑' : '新增'}${label}`;
    const values = item ?? (kind === 'sites' ? { sortOrder: 0 } : { order: 0, color: '#2563eb', icon: 'lucide:folder' });
    for (const input of Array.from(form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('[name]'))) {
      const value = (values as unknown as Record<string, unknown>)[input.name];
      input.value = Array.isArray(value) ? value.join(', ') : value == null ? '' : String(value);
    }
    (control('slug') as HTMLInputElement).readOnly = !!item;
    if (kind === 'sites' && item && !categories.some(category => category.id === (item as Site).category)) {
      const select = control('category') as HTMLSelectElement;
      option(select, (item as Site).category, `未找到分类（${(item as Site).category}）`); select.value = (item as Site).category;
    }
    baseline = draft(); dialog.showModal(); control('name').focus();
  }
  function openDetails(item: Item) {
    const entries: [string, string][] = [['名称', item.name], ['Slug', item.slug]];
    if (kind === 'sites') {
      const site = item as Site;
      entries.push(['站点地址', site.url], ['所属分类', categories.find(category => category.id === site.category)?.name ?? site.category],
        ['标签', site.tags.join('、')], ['验证状态', statusLabel(site)], ['排序', String(site.sortOrder)], ['描述', site.description]);
    } else {
      const category = item as Category;
      entries.push(['站点数量', String(categoryCount(category))], ['排序', String(category.order)], ['图标', category.icon], ['颜色', category.color]);
    }
    const details = el('[data-content-details]'); details.replaceChildren();
    for (const [label, value] of entries) {
      const term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label; description.textContent = value || '—'; details.append(term, description);
    }
    detailsDialog.showModal();
  }
  async function mutate(method: 'POST' | 'PATCH' | 'DELETE', body: unknown) {
    if (new TextEncoder().encode(JSON.stringify(body)).byteLength > 16 * 1024) throw new Error('请求内容不能超过 16 KiB，请缩短表单内容。');
    const result = await request(kind, method, body);
    if (!object(result) || !object(result.data) || typeof result.data.id !== 'string') throw new Error('服务器响应缺少 ID，操作可能已生效，请先关闭弹窗并刷新确认，勿重复提交。');
  }
  async function remove(item: Item) {
    if (!writable || loading || submitting || !window.confirm(`确定删除${label}「${item.name}」吗？此操作不可撤销。${kind === 'categories' ? '有关联站点的分类不能删除。' : ''}`)) return;
    submitting = true; showError(errorBox); render();
    try { await mutate('DELETE', { kind, id: item.id, revision: item.revision }); await load(); }
    catch (error) { if (!requests.signal.aborted) showError(errorBox, message(error)); }
    finally { submitting = false; if (!requests.signal.aborted) render(); }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (!writable || submitting || loading || !form.reportValidity()) return;
    showError(formError);
    const value = (name: string) => control(name).value.trim();
    let item: Record<string, unknown>;
    try {
      const text = (name: string, label: string, max: number, empty = false) => {
        const result = value(name);
        if ((!empty && !result) || result.length > max || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label}不能为空、超过 ${max} 字符或包含换行等控制字符。`);
        return result;
      };
      const name = text('name', '名称', 100), slug = selected?.slug ?? text('slug', 'Slug', 191);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 191 || (kind === 'categories' && reservedSlugs.has(slug))) {
        throw new Error('Slug 仅允许小写字母、数字及单个连字符分隔，且分类不能占用系统路径。');
      }
      const order = Number(value(kind === 'sites' ? 'sortOrder' : 'order'));
      if (!Number.isSafeInteger(order) || order < 0 || order > 1000000) throw new Error('排序须为 0–1000000 的整数。');
      if (kind === 'sites') {
        const url = text('url', '网址', 2048);
        if (!/^https?:\/\//i.test(url) || /[\\\s]/.test(url)) throw new Error('网址仅支持 HTTP(S)，不能含空白或反斜杠。');
        const parsed = new URL(url);
        if (!parsed.hostname || parsed.username || parsed.password) throw new Error('网址无效或包含账号密码。');
        const category = text('category', '分类', 64);
        if (!/^[a-zA-Z0-9_-]+$/.test(category)) throw new Error('分类编号无效。');
        const tags = value('tags').split(/[,，\n]/).map(tag => tag.trim()).filter(Boolean);
        if (tags.length > 30 || tags.some(tag => tag.length > 50 || /[\u0000-\u001f\u007f]/.test(tag))) throw new Error('标签最多 30 个，每个最多 50 字符，不能含控制字符。');
        item = { name, slug, url, category, description: text('description', '描述', 2000, true), tags: [...new Set(tags)], sortOrder: order };
        if (selected && category !== (selected as Site).category && !window.confirm('更改所属分类会改变站点详情链接，原链接可能失效。确定保存吗？')) return;
      } else {
        const color = text('color', '颜色', 7), icon = text('icon', '图标', 100);
        if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error('颜色须为六位十六进制色值。');
        if (!iconNames.has(icon)) throw new Error('请选择已安装的 lucide 图标。');
        item = { name, slug, color, icon, order };
      }
    } catch (error) { showError(formError, message(error)); return; }
    submitting = true; render();
    try {
      await mutate(selected ? 'PATCH' : 'POST', { kind, item, ...(selected ? { id: selected.id, revision: selected.revision } : {}) });
      dialog.close(); await load();
    } catch (error) { if (!requests.signal.aborted) showError(formError, message(error)); }
    finally { submitting = false; if (!requests.signal.aborted) render(); }
  }, options);
  rows.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null;
    if (!button || button.disabled) return;
    const item = items.find(item => item.id === button.dataset.id); if (!item) return;
    if (button.dataset.action === 'details') openDetails(item);
    else if (button.dataset.action === 'edit') openEditor(item);
    else if (button.dataset.action === 'delete') void remove(item);
  }, options);
  add.addEventListener('click', () => openEditor(null), options);
  refresh.addEventListener('click', () => { if (!submitting) void load(); }, options);
  cancels.forEach(cancel => cancel.addEventListener('click', closeEditor, options));
  root.querySelectorAll('[data-content-details-close]').forEach(button => button.addEventListener('click', () => detailsDialog.close(), options));
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeEditor(); }, options);
  window.addEventListener('beforeunload', event => {
    if (!dirty() && !submitting) return;
    event.preventDefault();
    // 兼容浏览器原生离页确认；不在此清除草稿或中止请求。
    Reflect.set(event, 'returnValue', '');
  }, options);
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-shell-logout]') || (!dirty() && !submitting)) return;
    if (submitting || !window.confirm('退出登录将离开当前页，未保存的草稿会丢失。确定退出吗？')) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, { ...options, capture: true });
  const filterForm = el<HTMLFormElement>('[data-admin-filter]');
  filterForm.addEventListener('submit', event => {
    event.preventDefault();
    applied = { query: query.value.trim().toLocaleLowerCase(), category: filter?.value ?? '', verification: verification?.value ?? '' };
    page = 1; render();
  }, options);
  filterForm.addEventListener('reset', event => {
    event.preventDefault(); query.value = ''; if (filter) filter.value = ''; if (verification) verification.value = '';
    applied = { query: '', category: '', verification: '' }; page = 1; render();
  }, options);
  pageSizeSelect.addEventListener('change', () => {
    pageSizeSelect.value = '10'; pageSize = 10; page = 1; render();
  }, options);
  prev.addEventListener('click', () => { page = Math.max(1, page - 1); render(); }, options);
  next.addEventListener('click', () => { page++; render(); }, options);
  function dispose() { pagination.destroy(); requests.abort(); events.abort(); if (dialog.open) dialog.close(); if (detailsDialog.open) detailsDialog.close(); mounted.delete(root!); }
  document.addEventListener('astro:before-swap', dispose, options);
  window.addEventListener('pagehide', dispose, options);
  void load();
}
document.addEventListener('astro:page-load', () => initContent('sites'));
window.addEventListener('pageshow', event => { if (event.persisted) initContent('sites'); });
initContent('sites');

