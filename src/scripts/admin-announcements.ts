import { bindAdminPagination } from './admin-pagination.ts';
import { parseNotificationPage, type NotificationItem } from '../lib/notification-view.ts';
let cleanup: (() => void) | undefined;
function initAnnouncements() {
  cleanup?.();
  const root = document.querySelector<HTMLElement>('[data-announcements-admin]');
  if (!root) return;
  const el = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector<T>(`[data-announcement-${name}]`)!;
  const form = el<HTMLFormElement>('form'), dialog = el<HTMLDialogElement>('dialog');
  const title = form.elements.namedItem('title') as HTMLInputElement;
  const body = form.elements.namedItem('body') as HTMLTextAreaElement;
  const fields = form.querySelector('fieldset')!;
  const formMessage = el('form-message'), heading = el('editor-title'), message = el('message'), list = el('list'), count = el('page');
  const save = el<HTMLButtonElement>('save'), cancel = el<HTMLButtonElement>('cancel'), close = el<HTMLButtonElement>('close');
  const add = el<HTMLButtonElement>('add'), refresh = el<HTMLButtonElement>('refresh');
  const prev = el<HTMLButtonElement>('prev'), next = el<HTMLButtonElement>('next'), size = el<HTMLSelectElement>('size');
  const lifecycle = new AbortController(), options = { signal: lifecycle.signal };
  let page = 1, total = 0, pageSize = 10, loaded = false, busy = false, viewing = false;
  let selected: string | null = null, revision: string | undefined, draftId = '', baseline = '';
  let requests = new AbortController();
  let items: NotificationItem[] = [];
  const pager = bindAdminPagination(root.querySelector<HTMLElement>('.admin-pagination')!, target => { if (!busy && loaded) { page = target; void operation(load); } });
  const fingerprint = () => JSON.stringify([title.value, body.value]);
  const dirty = () => dialog.open && !viewing && baseline !== fingerprint();
  function feedback(target: HTMLElement, text = '') { target.textContent = text; target.hidden = !text; }
  async function request(method = 'GET', value?: unknown) {
    const signal = AbortSignal.any([requests.signal, lifecycle.signal, AbortSignal.timeout(15000)]);
    const response = await fetch(method === 'GET' ? `/api/admin/announcements?page=${page}&pageSize=${pageSize}` : '/api/admin/announcements', {
      method, credentials: 'same-origin', cache: 'no-store', signal,
      ...(value ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) } : {}),
    });
    signal.throwIfAborted();
    if (response.status === 401) {
      el('login').hidden = false;
      throw new Error('登录已过期，请在新标签页登录后台后重试，当前草稿已保留。');
    }
    const result = await response.json();
    signal.throwIfAborted();
    if (response.status === 409) throw new Error(`${result.error?.message ?? '公告版本冲突。'} 当前草稿已保留，请核对最新公告后再操作。`);
    if (!response.ok) throw new Error(result.error?.message ?? '公告操作失败。');
    return result.data;
  }
  function state(value: boolean) {
    busy = value; fields.disabled = value;
    for (const button of [save, cancel, close, add, refresh, size]) button.disabled = value;
    save.hidden = viewing; title.readOnly = viewing; body.readOnly = viewing;
    refresh.textContent = value ? '加载中…' : '刷新';
    prev.disabled = value || !loaded || page <= 1; next.disabled = value || !loaded || page * pageSize >= total;
    list.querySelectorAll<HTMLButtonElement>('button').forEach(button => { button.disabled = value; });
    list.setAttribute('aria-busy', String(value));
    pager.update({ page, totalPages: Math.max(1, Math.ceil(total / pageSize)), total, pageSize, busy: value || !loaded });
  }
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text: string) {
    const element = document.createElement(tag); element.textContent = text; return element;
  }
  function open(item: NotificationItem | null, readOnly = false) {
    if (busy) return;
    selected = item?.id ?? null; revision = item?.revision; draftId = item ? '' : crypto.randomUUID(); viewing = readOnly;
    title.value = item?.title ?? ''; body.value = item?.body ?? '';
    heading.textContent = readOnly ? '公告详情' : item ? '编辑公告' : '新增公告';
    save.textContent = item ? '保存修改' : '发布公告'; cancel.textContent = readOnly ? '关闭' : '取消';
    baseline = fingerprint(); feedback(formMessage); state(false); dialog.showModal();
    (viewing ? close : title).focus();
  }
  function dismiss() {
    if (busy || dirty() && !confirm('存在未保存的修改，确定关闭吗？')) return;
    dialog.close();
  }
  async function load() {
    const current = requests;
    loaded = false; feedback(message);
    try {
      const data = parseNotificationPage(await request());
      if (data.items.some(item => item.kind !== 'announcement' || !item.revision || !/^[a-f0-9]{64}$/.test(item.revision))) throw new Error('公告列表格式异常。');
      total = data.total; page = data.page;
      if (!data.items.length && page > 1) { page = Math.max(1, Math.ceil(total / pageSize)); return load(); }
      items = data.items; list.replaceChildren();
      for (const [index, item] of items.entries()) {
        const row = node('tr', '');
        const cell = (text: string, className = '') => { const td = node('td', text); td.className = className; row.append(td); return td; };
        cell(String((page - 1) * pageSize + index + 1), 'admin-col-index');
        const name = node('span', item.title); name.className = 'admin-cell-title'; name.title = item.title; cell('').append(name);
        const summary = node('span', item.body); summary.className = 'admin-cell-ellipsis'; cell('').append(summary);
        cell(new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }), 'admin-col-time');
        const actions = node('div', ''); actions.className = 'content-actions';
        for (const [action, label] of [['detail', '详情'], ['edit', '编辑'], ['delete', '删除']]) {
          const button = node('button', label); button.type = 'button'; button.dataset.id = item.id; button.dataset.action = action;
          if (action === 'delete') button.className = 'content-danger';
          button.setAttribute('aria-label', `${label}公告：${item.title}`); actions.append(button);
        }
        cell('', 'admin-col-actions').append(actions); list.append(row);
      }
      if (!items.length) { const row = node('tr', ''); const td = node('td', '无数据'); td.colSpan = 5; td.className = 'content-empty'; row.append(td); list.append(row); }
      count.textContent = `共 ${total} 条 · 第 ${page} / ${Math.max(1, Math.ceil(total / pageSize))} 页 · 每页 ${pageSize} 条`;
      loaded = true;
    } catch (error) {
      if (!current.signal.aborted) { items = []; list.replaceChildren(); count.textContent = '加载失败'; }
      throw error;
    }
  }
  async function operation(action: () => Promise<void>, target = message) {
    if (busy) return; feedback(target); state(true);
    const current = requests;
    try { await action(); }
    catch (error) { if (!lifecycle.signal.aborted && !current.signal.aborted) feedback(target, error instanceof Error ? error.message : '操作失败，请重试。'); }
    finally { if (!lifecycle.signal.aborted && !current.signal.aborted) state(false); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!dialog.open || viewing || !form.reportValidity()) return;
    if (!title.value.trim() || !body.value.trim()) { feedback(formMessage, '标题和正文不能为空。'); return; }
    void operation(async () => {
      await request(selected ? 'PUT' : 'POST', { ...(selected ? { id: selected, revision } : { id: draftId }), title: title.value.trim(), body: body.value.trim() });
      form.reset(); baseline = fingerprint(); draftId = ''; dialog.close(); page = 1;
      try { await load(); } catch { feedback(message, '保存成功，列表刷新失败，请重试刷新。'); }
    }, formMessage);
  }, options);
  cancel.addEventListener('click', dismiss, options); close.addEventListener('click', dismiss, options);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); }, options);
  add.addEventListener('click', () => open(null), options);
  list.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-action]') : null;
    const item = items.find(item => item.id === button?.dataset.id);
    if (!button || !item || busy) return;
    if (button.dataset.action !== 'delete') { open(item, button.dataset.action === 'detail'); return; }
    if (!confirm(`确定删除公告“${item.title}”？删除后前台将不再显示，此操作不可恢复。`)) return;
    void operation(async () => { await request('DELETE', { id: item.id, revision: item.revision }); try { await load(); } catch { feedback(message, '删除成功，列表刷新失败，请重试刷新。'); } });
  }, options);
  refresh.addEventListener('click', () => void operation(load), options);
  prev.addEventListener('click', () => { if (busy || !loaded || page <= 1) return; page--; void operation(load); }, options);
  next.addEventListener('click', () => { if (busy || !loaded || page * pageSize >= total) return; page++; void operation(load); }, options);
  size.addEventListener('change', () => { if (busy) return; size.value = '10'; pageSize = 10; page = 1; void operation(load); }, options);
  window.addEventListener('beforeunload', event => { if (dirty() || busy && dialog.open) { event.preventDefault(); Reflect.set(event, 'returnValue', ''); } }, options);
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element) || !event.target.closest('[data-shell-logout]') || !dialog.open) return;
    if (busy || dirty() && !confirm('退出将丢失未保存的公告，确定退出吗？')) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { ...options, capture: true });
  cleanup = () => { requests.abort(); lifecycle.abort(); pager.destroy(); if (dialog.open) dialog.close(); };
  window.addEventListener('pagehide', () => { requests.abort(); }, options);
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    requests.abort(); requests = new AbortController(); state(false);
    void operation(load);
  }, options);
  void operation(load);
}
initAnnouncements();
