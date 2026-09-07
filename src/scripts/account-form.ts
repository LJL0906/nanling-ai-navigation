import { safeAccountNext } from './account-next.ts';
import { notifyAccountChanged } from './account-events.ts';

function initializeAccountForms() {
  const next = safeAccountNext(new URLSearchParams(location.search).get('next'));
  document.querySelectorAll<HTMLAnchorElement>('[data-account-switch]').forEach(link => {
    link.href = `${link.pathname}?next=${encodeURIComponent(next)}`;
  });
  document.querySelectorAll<HTMLFormElement>('[data-account-form]').forEach(form => {
    if (form.dataset.bound) return;
    form.dataset.bound = 'true';
    const message = form.querySelector<HTMLElement>('[data-account-message]')!;
    const button = form.querySelector<HTMLButtonElement>('button[type=submit]')!;
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.pending === 'true' || !form.reportValidity()) return;
      const fields = new FormData(form);
      const mode = form.dataset.accountForm === 'register' ? 'register' : 'login';
      const dialog = form.closest<HTMLDialogElement>('dialog');
      const controls = [...form.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button'),
        ...(dialog?.querySelectorAll<HTMLButtonElement>('[data-account-mode]') ?? [])];
      form.dataset.pending = 'true';
      form.setAttribute('aria-busy', 'true');
      controls.forEach(control => { control.disabled = true; });
      const label = button.textContent;
      button.textContent = '正在提交…';
      message.textContent = '';
      delete message.dataset.error;
      try {
        const response = await fetch(mode === 'register' ? '/api/account/register' : '/api/account/session', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: fields.get('username'), password: fields.get('password') }),
        });
        let result;
        try { result = await response.json(); }
        catch { throw new Error('账号服务响应异常，请稍后重试。'); }
        if (!response.ok) throw new Error(result.error?.message ?? '操作失败，请稍后重试。');
        form.reset();
        dialog?.close();
        notifyAccountChanged(mode);
        if (!form.hasAttribute('data-account-modal')) location.assign(next);
      } catch (error) {
        message.dataset.error = 'true';
        message.textContent = error instanceof TypeError ? '网络连接失败，请检查网络后重试。'
          : error instanceof Error ? error.message : '操作失败，请稍后重试。';
      } finally {
        form.dataset.pending = 'false';
        form.removeAttribute('aria-busy');
        controls.forEach(control => { control.disabled = false; });
        button.textContent = label;
      }
    });
  });
}
initializeAccountForms();
document.addEventListener('astro:page-load', initializeAccountForms);
