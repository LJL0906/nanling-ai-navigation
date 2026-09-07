let cleanup: (() => void) | undefined;
function initLogin() {
  cleanup?.();
  const form = document.querySelector<HTMLFormElement>('#admin-login-form');
  if (!form) return;
  const events = new AbortController();
  const message = document.querySelector<HTMLElement>('#login-message')!;
  const button = form.querySelector<HTMLButtonElement>('button')!;
  const password = form.querySelector<HTMLInputElement>('#password')!;
  const requested = new URLSearchParams(location.search).get('next') ?? '/admin/';
  const next = /^\/admin\/(?!login(?:\/|[?#]|$))[a-zA-Z0-9/_-]*(?:[?#][^\s\\\u0000-\u001f\u007f]*)?$/.test(requested) ? requested : '/admin/';
  let busy = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true; button.disabled = true; button.textContent = '正在登录…';
    message.textContent = '正在验证管理员账号…';
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        signal: events.signal,
        body: JSON.stringify({ username: form.querySelector<HTMLInputElement>('#username')!.value.trim(), password: password.value }),
      });
      const result = await response.json();
      password.value = '';
      if (!response.ok) throw new Error(result.error?.message || '登录失败，请稍后重试。');
      message.textContent = '登录成功，正在进入管理后台…';
      window.location.replace(next);
    } catch (error) {
      if (events.signal.aborted) return;
      password.value = '';
      message.textContent = error instanceof Error ? error.message : '网络异常，请重试。';
    } finally { busy = false; button.disabled = false; button.textContent = '登录管理后台'; }
  }, { signal: events.signal });
  void fetch('/api/admin/session', { cache: 'no-store', signal: events.signal })
    .then(response => { if (response.ok && !busy) window.location.replace(next); }).catch(() => {});
  cleanup = () => { events.abort(); password.value = ''; };
  document.addEventListener('astro:before-swap', () => cleanup?.(), { once: true, signal: events.signal });
}
document.addEventListener('astro:page-load', initLogin);
window.addEventListener('pageshow', event => { if (event.persisted) initLogin(); });
initLogin();
