import { initializeAccountEvents, notifyAccountChanged } from './account-events.ts';
initializeAccountEvents();

function renderAccountMenu(username: string | null) {
  const label = username || '未登录';
  document.querySelectorAll<HTMLElement>('[data-account-menu-name]').forEach(node => { node.textContent = label; });
  document.querySelectorAll<HTMLElement>('[data-account-menu-avatar]').forEach(node => { node.textContent = Array.from(label)[0].toUpperCase(); });
  document.querySelectorAll<HTMLElement>('[data-account-menu-trigger]').forEach(node => { node.setAttribute('aria-label', `${label}的用户菜单`); });
  document.querySelectorAll<HTMLElement>('[data-account-menu-login]').forEach(node => { node.hidden = !!username; });
}
let generation = 0;
async function refreshAccountStatus() {
  const current = ++generation;
  renderAccountMenu(null);
  const roots = [...document.querySelectorAll<HTMLElement>('[data-account-status]')];
  if (!roots.length) return;
  for (const root of roots) {
    const logout = root.querySelector<HTMLButtonElement>('[data-account-logout]')!;
    if (logout.dataset.bound) continue;
    logout.dataset.bound = 'true';
    logout.addEventListener('click', async () => {
      logout.disabled = true;
      const message = root.querySelector<HTMLElement>('[data-account-status-message]')!;
      try {
        const response = await fetch('/api/account/session', { method: 'DELETE', credentials: 'same-origin' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error?.message ?? '退出失败，请重试。');
        message.textContent = '';
        notifyAccountChanged('logout');
      } catch { message.textContent = '退出失败，请稍后重试。'; }
      finally { logout.disabled = false; }
    });
  }
  try {
    const response = await fetch('/api/account/session', { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) throw new Error('Session unavailable');
    const { data } = await response.json();
    if (current !== generation) return;
    renderAccountMenu(data.user?.username ?? null);
    for (const root of roots) {
      root.querySelector<HTMLElement>('[data-account-anonymous]')!.hidden = !!data.user;
      root.querySelector<HTMLElement>('[data-account-member]')!.hidden = !data.user;
      root.querySelector<HTMLElement>('[data-account-name]')!.textContent = data.user?.username ?? '';
      root.querySelector<HTMLElement>('[data-account-status-message]')!.textContent = '';
    }
  } catch {
    if (current !== generation) return;
    for (const root of roots) {
      root.querySelector<HTMLElement>('[data-account-anonymous]')!.hidden = false;
      root.querySelector<HTMLElement>('[data-account-member]')!.hidden = true;
      root.querySelector<HTMLElement>('[data-account-name]')!.textContent = '';
      root.querySelector<HTMLElement>('[data-account-status-message]')!.textContent = '账号服务暂不可用';
    }
  }
}
void refreshAccountStatus();
document.addEventListener('astro:page-load', () => { void refreshAccountStatus(); });
document.addEventListener('nav:account-changed', () => { void refreshAccountStatus(); });
window.addEventListener('pageshow', event => { if (event.persisted) void refreshAccountStatus(); });

