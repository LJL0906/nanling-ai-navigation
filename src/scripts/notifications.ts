import { parseNotificationPage, notificationStatus, type NotificationKind } from '../lib/notification-view.ts';
import { initializeAccountEvents } from './account-events.ts';
initializeAccountEvents();
function initializeNotifications() {
  const root = document.querySelector<HTMLDialogElement>('[data-notifications]');
  if (!root || root.dataset.bound) return;
  root.dataset.bound = 'true';
  const list = root.querySelector<HTMLElement>('[data-notification-list]')!;
  const message = root.querySelector<HTMLElement>('[data-notification-message]')!;
  const login = root.querySelector<HTMLElement>('[data-notification-login]')!;
  const count = root.querySelector<HTMLElement>('[data-notification-page]')!;
  const prev = root.querySelector<HTMLButtonElement>('[data-notification-prev]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-notification-next]')!;
  const refresh = root.querySelector<HTMLButtonElement>('[data-notification-refresh]')!;
  const tabs = [...root.querySelectorAll<HTMLButtonElement>('[data-notification-kind]')];
  const initial = new URL(location.href).searchParams.get('notifications');
  const pagination = root.querySelector<HTMLElement>('[data-notification-pagination]')!;
  let previousOverflow = '';
  let resumeAfterLogin = false;
  let kind: NotificationKind = initial === 'submission' || initial === 'announcement' ? initial : 'site';
  let page = 1;
  let generation = 0;
  let request: AbortController | undefined;
  function element<K extends keyof HTMLElementTagNameMap>(tag: K, text: string, className = '') {
    const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
  }
  async function load() {
    const current = ++generation;
    request?.abort(); request = new AbortController();
    const signal = request.signal;
    const timeout = setTimeout(() => request?.signal === signal && request.abort(), 15000);
    // 换账号或分类时立即清除旧私人内容，过期请求不能回填。
    list.replaceChildren(); list.setAttribute('aria-busy', 'true');
    login.hidden = true; prev.disabled = true; next.disabled = true; refresh.disabled = true;
    count.textContent = ''; pagination.hidden = true; message.textContent = '加载中…';
    tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.notificationKind === kind)));
    try {
      const response = await fetch(`/api/notifications?kind=${kind}&page=${page}&pageSize=20`, { credentials: 'same-origin', cache: 'no-store', signal });
      const result = await response.json();
      if (current !== generation) return;
      if (response.status === 401) { login.hidden = false; message.textContent = ''; return; }
      if (!response.ok) throw new Error(result.error?.message ?? '消息加载失败，请重试。');
      const data = parseNotificationPage(result.data);
      if (data.items.some(item => item.kind !== kind)) throw new Error('消息分类异常，请重试。');
      page = data.page;
      if (!data.items.length && page > 1) { page = Math.max(1, Math.ceil(data.total / data.pageSize)); void load(); return; }
      for (const item of data.items) {
        const row = element('li', '', 'notification-card');
        const heading = element('div', '', 'notification-card-heading');
        heading.append(element('h2', item.title));
        const status = notificationStatus(item.status);
        if (status && status !== item.title) heading.append(element('span', status, `notification-badge ${item.status === 'rejected' ? 'is-rejected' : ''}`));
        row.append(heading, element('p', item.body, 'notification-body'));
        if (item.reason) row.append(element('p', `审核说明：${item.reason}`, 'notification-reason'));
        const time = element('time', new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false }));
        time.dateTime = item.createdAt; row.append(time); list.append(row);
      }
      message.textContent = data.items.length ? '' : '暂无消息';
      count.textContent = `${page} / ${Math.max(1, Math.ceil(data.total / data.pageSize))}`;
      pagination.hidden = data.total <= data.pageSize;
      prev.disabled = page <= 1; next.disabled = page * data.pageSize >= data.total;
    } catch (error) {
      if (current !== generation) return;
      message.textContent = signal.aborted ? '加载超时，请刷新重试。' : error instanceof Error ? error.message : '消息加载失败，请重试。';
    } finally {
      clearTimeout(timeout);
      if (current === generation) { list.setAttribute('aria-busy', 'false'); refresh.disabled = false; }
    }
  }
  tabs.forEach(tab => tab.addEventListener('click', () => {
    kind = tab.dataset.notificationKind as NotificationKind; page = 1;
    void load();
  }));
  prev.addEventListener('click', () => { page--; void load(); });
  next.addEventListener('click', () => { page++; void load(); });
  refresh.addEventListener('click', () => void load());
  function open() {
    if (!root!.open) {
      previousOverflow = document.documentElement.style.overflow;
      root!.showModal(); document.documentElement.style.overflow = 'hidden';
    }
    void load();
  }
  function clear() { generation++; request?.abort(); list.replaceChildren(); message.textContent = ''; }
  root.querySelector('[data-notification-close]')!.addEventListener('click', () => root.close());
  root.addEventListener('click', event => {
    if (event.target !== root) return;
    const bounds = root.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) root.close();
  });
  root.addEventListener('close', () => { document.documentElement.style.overflow = previousOverflow; clear(); });
  const openFromLink = (event: MouseEvent) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || !(event.target instanceof Element)) return;
    const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
    if (!anchor) return;
    const target = new URL(anchor.href, location.href);
    if (target.origin !== location.origin || !/^\/notifications\/?$/.test(target.pathname)) return;
    event.preventDefault();
    kind = target.searchParams.get('kind') === 'submission' ? 'submission' : target.searchParams.get('kind') === 'announcement' ? 'announcement' : 'site';
    page = 1; open();
  };
  document.addEventListener('click', openFromLink, true);
  root.querySelector('[data-notification-login-action]')!.addEventListener('click', event => {
    event.preventDefault(); resumeAfterLogin = true; root.close();
    document.dispatchEvent(new CustomEvent('nav:auth-required'));
  });
  const accountChanged = (event: Event) => {
    page = 1; clear();
    const reason = (event as CustomEvent).detail?.reason;
    if (resumeAfterLogin && (reason === 'login' || reason === 'register')) { resumeAfterLogin = false; kind = 'submission'; open(); }
    else if (root.open) void load();
  };
  const pageShown = (event: PageTransitionEvent) => { if (event.persisted) { clear(); if (root.open) void load(); } };
  const pageHidden = () => { if (root.open) root.close(); clear(); };
  document.addEventListener('nav:account-changed', accountChanged);
  window.addEventListener('pageshow', pageShown);
  window.addEventListener('pagehide', pageHidden);
  document.addEventListener('astro:before-swap', () => {
    pageHidden();
    document.removeEventListener('click', openFromLink, true);
    document.removeEventListener('nav:account-changed', accountChanged);
    window.removeEventListener('pageshow', pageShown);
    window.removeEventListener('pagehide', pageHidden);
  }, { once: true });
  if (initial !== null) {
    const url = new URL(location.href); url.searchParams.delete('notifications'); history.replaceState(null, '', url);
    open();
  }
}
initializeNotifications();
document.addEventListener('astro:page-load', initializeNotifications);
