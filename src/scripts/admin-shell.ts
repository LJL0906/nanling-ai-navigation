const toggle = document.querySelector<HTMLButtonElement>('[data-shell-toggle]');
const backdrop = document.querySelector<HTMLButtonElement>('[data-shell-close]');
function setMenu(open: boolean) {
  document.body.classList.toggle('admin-menu-open', open);
  toggle?.setAttribute('aria-expanded', String(open));
  if (backdrop) backdrop.hidden = !open;
}
toggle?.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
backdrop?.addEventListener('click', () => { setMenu(false); toggle?.focus(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') setMenu(false); });
const logout = document.querySelector<HTMLButtonElement>('[data-shell-logout]');
const localLogout = document.querySelector<HTMLButtonElement>('#menu-logout, #review-logout, [data-admin-logout]');
if (logout && localLogout) {
  const syncLogout = () => { logout.disabled = localLogout.disabled; };
  new MutationObserver(syncLogout).observe(localLogout, { attributes: true, attributeFilter: ['disabled'] });
  syncLogout();
}
logout?.addEventListener('click', async () => {
  // 菜单工作台保留既有的未保存草稿确认，不绕过其退出处理。
  const local = document.querySelector<HTMLButtonElement>('#menu-logout, #review-logout, [data-admin-logout]');
  if (local) { local.click(); return; }
  logout.disabled = true;
  try {
    const response = await fetch('/api/admin/session', { method: 'DELETE' });
    if (!response.ok) throw new Error();
    location.replace('/admin/login/');
  } catch {
    const message = document.querySelector<HTMLElement>('[data-shell-message]');
    if (message) { message.hidden = false; message.textContent = '退出登录失败，请检查网络后重试。'; }
  } finally { logout.disabled = false; }
});
window.addEventListener('pageshow', event => {
  if (!event.persisted || !document.body.classList.contains('admin-app')) return;
  void fetch('/api/admin/session', { cache: 'no-store' }).then(response => {
    if (response.status === 401) location.replace('/admin/login/');
  }).catch(() => {});
});
