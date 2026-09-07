import './account-form.ts';

function setMode(dialog: HTMLDialogElement, mode: 'login' | 'register') {
  const form = dialog.querySelector<HTMLFormElement>('[data-account-form]')!;
  if (form.dataset.pending === 'true') return;
  const register = mode === 'register';
  form.dataset.accountForm = mode;
  form.action = register ? '/api/account/register' : '/api/account/session';
  dialog.querySelector<HTMLElement>('#account-dialog-title')!.textContent = register ? '创建账号' : '登录账号';
  form.querySelector<HTMLInputElement>('[name=password]')!.autocomplete = register ? 'new-password' : 'current-password';
  form.querySelector<HTMLButtonElement>('[type=submit]')!.textContent = register ? '注册并登录' : '登录';
  const message = form.querySelector<HTMLElement>('[data-account-message]')!;
  message.textContent = '';
  delete message.dataset.error;
  dialog.querySelectorAll<HTMLButtonElement>('[data-account-mode]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.accountMode === mode));
  });
}
function openAccountDialog(mode: 'login' | 'register' = 'login') {
  const dialog = document.querySelector<HTMLDialogElement>('[data-account-dialog]');
  if (!dialog) return;
  setMode(dialog, mode);
  if (!dialog.open) dialog.showModal();
  dialog.querySelector<HTMLInputElement>('[name=username]')?.focus();
}
function initializeAccountDialog() {
  const dialog = document.querySelector<HTMLDialogElement>('[data-account-dialog]');
  if (!dialog || dialog.dataset.bound) return;
  dialog.dataset.bound = 'true';
  dialog.querySelector<HTMLButtonElement>('[data-account-close]')!.addEventListener('click', () => dialog.close());
  dialog.querySelectorAll<HTMLButtonElement>('[data-account-mode]').forEach(button => {
    button.addEventListener('click', () => setMode(dialog, button.dataset.accountMode === 'register' ? 'register' : 'login'));
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    const form = dialog.querySelector<HTMLFormElement>('form')!;
    form.reset();
    form.querySelector<HTMLElement>('[data-account-message]')!.textContent = '';
  });
  // showModal 原生提供焦点约束、ESC 关闭及关闭后的焦点恢复。
}
initializeAccountDialog();
document.addEventListener('astro:page-load', initializeAccountDialog);
document.addEventListener('astro:before-swap', () => document.querySelector<HTMLDialogElement>('[data-account-dialog][open]')?.close());
document.addEventListener('nav:auth-required', () => openAccountDialog('login'));
document.addEventListener('click', event => {
  if (!(event.target instanceof Element)) return;
  const opener = event.target.closest<HTMLElement>('[data-account-open]');
  if (!opener) return;
  event.preventDefault();
  openAccountDialog(opener.dataset.accountOpen === 'register' ? 'register' : 'login');
});
