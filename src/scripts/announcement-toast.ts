import { parseNotificationPage } from '../lib/notification-view.ts';

// 每次整页进入只弹一次，Astro 站内切换不重复打扰；刷新后可再次显示。
let initialized = false;
function initializeAnnouncementToast() {
  if (initialized || /^\/admin(?:\/|$)/.test(location.pathname)) return;
  const root = document.querySelector<HTMLElement>('[data-announcement-toast]');
  if (!root) return;
  initialized = true;
  const title = root.querySelector<HTMLElement>('[data-announcement-toast-title]')!;
  const body = root.querySelector<HTMLElement>('[data-announcement-toast-body]')!;
  const close = root.querySelector<HTMLButtonElement>('[data-announcement-toast-close]')!;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const dismiss = () => {
    root.hidden = true;
    clearTimeout(timer);
  };
  const cleanup = () => {
    controller.abort();
    dismiss();
    close.removeEventListener('click', dismiss);
  };
  close.addEventListener('click', dismiss);
  document.addEventListener('astro:before-swap', cleanup, { once: true });
  window.addEventListener('pagehide', cleanup, { once: true });
  void (async () => {
    try {
      const response = await fetch('/api/notifications?kind=announcement&page=1&pageSize=1', {
        signal: controller.signal, credentials: 'same-origin', cache: 'no-store',
      });
      if (!response.ok || controller.signal.aborted) return;
      const result = await response.json();
      const announcement = parseNotificationPage(result.data).items[0];
      if (controller.signal.aborted || !announcement || announcement.kind !== 'announcement') return;
      title.textContent = announcement.title;
      body.textContent = announcement.body;
      root.hidden = false;
      timer = setTimeout(dismiss, 3000);
    } catch {
      // 公告是非阻塞提示；接口不可用时不影响正常浏览。
    }
  })();
}
initializeAnnouncementToast();
document.addEventListener('astro:page-load', initializeAnnouncementToast);
