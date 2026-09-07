import { bindAdminPagination } from './admin-pagination';
import type { ReviewItem } from '../server/submission-review';

type Page = { items: ReviewItem[]; total: number; page: number; totalPages: number };
const labels = { pending: '待审核', approved: '已通过', rejected: '已拒绝' };
let cleanup: (() => void) | undefined;
function initReviews() {
  const root = document.querySelector<HTMLElement>('[data-submission-reviews]');
  if (!root || root.dataset.ready) return;
  root.dataset.ready = 'true';
  const filters = root.querySelector<HTMLFormElement>('#review-filters')!;
  const status = root.querySelector<HTMLSelectElement>('#review-status')!;
  const query = root.querySelector<HTMLInputElement>('#review-query')!;
  let appliedQuery = '';
  const size = root.querySelector<HTMLSelectElement>('#review-size')!;
  const list = root.querySelector<HTMLTableSectionElement>('#review-list')!;
  const message = root.querySelector<HTMLElement>('#review-message')!;
  const pagination = root.querySelector<HTMLElement>('#review-page')!;
  const prev = root.querySelector<HTMLButtonElement>('#review-prev')!;
  const next = root.querySelector<HTMLButtonElement>('#review-next')!;
  const account = root.querySelector<HTMLElement>('#review-account')!;
  const logout = root.querySelector<HTMLButtonElement>('#review-logout')!;
  const dialog = root.querySelector<HTMLDialogElement>('#review-dialog')!;
  const dialogTitle = root.querySelector<HTMLElement>('#review-dialog-title')!;
  const dialogFields = root.querySelector<HTMLElement>('#review-dialog-fields')!;
  const form = root.querySelector<HTMLFormElement>('#review-form')!;
  const reason = root.querySelector<HTMLTextAreaElement>('#review-reason')!;
  const dialogMessage = root.querySelector<HTMLElement>('#review-dialog-message')!;
  const detailFooter = root.querySelector<HTMLElement>('#review-detail-footer')!;
  let selected: ReviewItem | undefined;
  let opener: HTMLButtonElement | undefined;
  let appliedStatus = status.value;
  const appliedSize = '10';
  let page = 1;
  let totalPages = 0;
  let total = 0;
  let busy = false;
  let loaded = false;
  const pager = bindAdminPagination(root.querySelector<HTMLElement>('.admin-pagination')!, (target: number) => {
    if (!busy) { page = target; void load(); }
  });
  const controller = new AbortController();
  cleanup = () => { controller.abort(); pager.destroy(); dialog.close(); delete root.dataset.ready; cleanup = undefined; };
  document.addEventListener('astro:before-swap', () => cleanup?.(), { once: true, signal: controller.signal });
  window.addEventListener('pagehide', () => cleanup?.(), { once: true, signal: controller.signal });
  function notify(text: string, error = false) { message.textContent = text; message.dataset.error = String(error); }
  function lock(value: boolean) {
    busy = value;
    list.setAttribute('aria-busy', String(value));
    root!.querySelectorAll<HTMLButtonElement | HTMLSelectElement | HTMLTextAreaElement | HTMLInputElement>('button, select, textarea, input')
      .forEach(control => { control.disabled = value; });
    pager.update({ page, totalPages, total, pageSize: Number(appliedSize), busy: value || !loaded });
    prev.disabled = value || !loaded || page <= 1;
    next.disabled = value || !loaded || page >= totalPages;
  }
  async function request<T>(url: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(url, { ...options, credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    if (response.status === 401) {
      window.location.assign('/admin/login/?next=%2Fadmin%2Freviews%2F');
      throw new Error('登录已过期，正在跳转登录页……');
    }
    const body = await response.json();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new Error('登录失效或无审核权限，请返回管理后台重新登录。');
      if (response.status === 409) throw new Error(body.error?.message || '审核冲突，请刷新后查看。');
      throw new Error(body.error?.message || '请求失败，请稍后重试。');
    }
    return body.data as T;
  }
  function field(dl: HTMLElement, title: string, value: string) {
    const dt = document.createElement('dt'); dt.textContent = title;
    const dd = document.createElement('dd'); dd.textContent = value || '—';
    dl.append(dt, dd);
  }
  function formatTime(value: string | null | undefined) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }
  function openRecord(record: ReviewItem, review: boolean, trigger: HTMLButtonElement) {
    if (busy) return;
    selected = record;
    opener = trigger;
    dialogTitle.textContent = review ? '审核提交' : '提交详情';
    dialogFields.replaceChildren();
    field(dialogFields, '网站名称', record.name);
    // URL 和图标仅作文本展示，不执行不可信链接、不自动加载远程图标。
    field(dialogFields, '网站地址', record.url);
    field(dialogFields, '分类', record.customCategory ? '自定义：' + record.customCategory : record.categoryId);
    field(dialogFields, '审核状态', labels[record.status]);
    field(dialogFields, '提交时间', formatTime(record.createdAt));
    field(dialogFields, '提交编号', record.id);
    field(dialogFields, '分类编号', record.categoryId);
    field(dialogFields, '自定义分类', record.customCategory);
    field(dialogFields, '图标地址', record.iconUrl);
    field(dialogFields, '私有备注', record.remark);
    field(dialogFields, '审核人', record.reviewedBy || '—');
    field(dialogFields, '审核时间', formatTime(record.reviewedAt));
    field(dialogFields, '审核理由', record.reviewReason || '—');
    if (record.status === 'approved') field(dialogFields, '发布状态', record.publishedSiteId ? '已发布：' + record.publishedSiteId : '历史审核记录，尚未发布');
    form.reset(); reason.setCustomValidity(''); dialogMessage.textContent = '';
    form.hidden = !review || record.status !== 'pending';
    detailFooter.hidden = !form.hidden;
    dialog.showModal();
    if (!form.hidden) reason.focus();
  }
  function render(record: ReviewItem, index: number) {
    const row = document.createElement('tr');
    function cell(value = '', className = '') {
      const td = document.createElement('td'); td.textContent = value; td.className = className;
      row.append(td); return td;
    }
    cell(String((page - 1) * Number(appliedSize) + index + 1));
    const name = cell();
    const title = document.createElement('span'); title.className = 'review-ellipsis'; title.textContent = record.name; title.title = record.name;
    const url = document.createElement('span'); url.className = 'content-secondary review-ellipsis'; url.textContent = record.url; url.title = record.url;
    name.append(title, url);
    const category = cell();
    const categoryText = document.createElement('span'); categoryText.className = 'review-ellipsis';
    categoryText.textContent = record.customCategory ? '自定义：' + record.customCategory : record.categoryId;
    categoryText.title = categoryText.textContent; category.append(categoryText);
    const badge = document.createElement('span'); badge.className = 'admin-badge'; badge.dataset.status = record.status; badge.textContent = labels[record.status];
    cell().append(badge);
    cell(formatTime(record.createdAt));
    cell(record.reviewedBy || '—', 'review-ellipsis');
    cell(formatTime(record.reviewedAt));
    const actions = document.createElement('div'); actions.className = 'content-actions';
    const details = document.createElement('button'); details.type = 'button'; details.className = 'secondary'; details.textContent = '详情';
    details.addEventListener('click', () => openRecord(record, false, details), { signal: controller.signal });
    if (record.status === 'pending') {
      const review = document.createElement('button'); review.type = 'button'; review.className = 'admin-primary'; review.textContent = '审核';
      review.addEventListener('click', () => openRecord(record, true, review), { signal: controller.signal });
      actions.append(review);
    }
    actions.append(details);
    cell().append(actions);
    list.append(row);
  }
  function closeRecord() {
    if (busy) return;
    if (!form.hidden && reason.value && !window.confirm('审核理由尚未保存，确定放弃并关闭？')) return;
    dialog.close();
  }
  root.querySelectorAll<HTMLButtonElement>('[data-review-close]').forEach(button => {
    button.addEventListener('click', closeRecord, { signal: controller.signal });
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); closeRecord(); }, { signal: controller.signal });
  dialog.addEventListener('close', () => {
    selected = undefined;
    if (!busy) (opener?.isConnected ? opener : status).focus();
  }, { signal: controller.signal });
  reason.addEventListener('input', () => reason.setCustomValidity(''), { signal: controller.signal });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || form.hidden || !selected || selected.status !== 'pending') return;
    const decision = (event.submitter as HTMLButtonElement | null)?.value;
    if (decision !== 'approved' && decision !== 'rejected') return;
    if (!reason.value.trim()) { reason.setCustomValidity('请填写审核理由。'); reason.reportValidity(); return; }
    if (!form.reportValidity()) return;
    lock(true); dialogMessage.textContent = '正在保存审核结果……';
    try {
      await request('/api/admin/submissions', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: selected.id, status: decision, reason: reason.value.trim() }) });
      reason.value = '';
      dialog.close();
      await load(decision === 'approved' ? '已通过并发布。' : '已拒绝。');
      const returnButton = Array.from(list.querySelectorAll<HTMLButtonElement>('button')).find(button => !button.disabled);
      (returnButton ?? status).focus();
    } catch (error) {
      if (!controller.signal.aborted) dialogMessage.textContent = error instanceof Error ? error.message : '审核失败，请重试。';
    } finally { lock(false); }
  }, { signal: controller.signal });
  async function load(success?: string) {
    lock(true); notify('正在加载提交记录……');
    try {
      const session = await request<{ username: string }>('/api/admin/session');
      account.textContent = `当前管理员：${session.username}`;
      let data = await request<Page>(`/api/admin/submissions?${new URLSearchParams({ status: appliedStatus, q: appliedQuery, page: String(page), pageSize: appliedSize })}`);
      if (page > Math.max(1, data.totalPages)) {
        page = Math.max(1, data.totalPages);
        data = await request<Page>(`/api/admin/submissions?${new URLSearchParams({ status: appliedStatus, q: appliedQuery, page: String(page), pageSize: appliedSize })}`);
      }
      page = data.page; totalPages = data.totalPages; total = data.total; loaded = true;
      list.replaceChildren(); data.items.forEach(render);
      if (!data.items.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 8; cell.className = 'content-empty'; cell.textContent = '无数据';
        row.append(cell); list.append(row);
      }
      pagination.textContent = `共 ${data.total} 条 · 第 ${page} / ${Math.max(1, totalPages)} 页 · 每页 ${appliedSize} 条`;
      notify(success ?? '');
    } catch (error) {
      loaded = false; total = 0; totalPages = 0; list.replaceChildren(); pagination.textContent = '加载失败';
      if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '加载失败。', true);
    } finally { lock(false); }
  }
  filters.addEventListener('submit', event => { event.preventDefault(); if (!busy) { appliedStatus = status.value; appliedQuery = query.value.trim(); size.value = '10'; page = 1; void load(); } }, { signal: controller.signal });
  filters.addEventListener('reset', event => {
    event.preventDefault();
    if (busy) return;
    status.value = appliedStatus = 'pending'; query.value = appliedQuery = ''; page = 1;
    void load();
  }, { signal: controller.signal });
  size.addEventListener('change', () => {
    if (busy) return;
    size.value = '10'; page = 1; void load();
  }, { signal: controller.signal });
  prev.addEventListener('click', () => { if (!busy && page > 1) { page--; void load(); } }, { signal: controller.signal });
  next.addEventListener('click', () => { if (!busy && page < totalPages) { page++; void load(); } }, { signal: controller.signal });
  logout.addEventListener('click', async () => {
    if (busy) return;
    lock(true);
    try { await request('/api/admin/session', { method: 'DELETE' }); window.location.assign('/admin/login/'); }
    catch (error) { if (!controller.signal.aborted) notify(error instanceof Error ? error.message : '退出失败，请重试。', true); }
    finally { lock(false); }
  }, { signal: controller.signal });
  void load();
}
initReviews();
document.addEventListener('astro:page-load', initReviews);



window.addEventListener('pageshow', event => { if (event.persisted) { cleanup?.(); initReviews(); } });
