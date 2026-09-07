import type { TransitionBeforePreparationEvent } from 'astro:transitions/client';

let active: symbol | undefined;
let slowTimer: ReturnType<typeof setTimeout> | undefined;
function display(message?: string) {
  const feedback = document.querySelector<HTMLElement>('[data-navigation-feedback]');
  const text = feedback?.querySelector<HTMLElement>('[data-navigation-message]');
  if (feedback) feedback.hidden = !message;
  if (text && message) text.textContent = message;
}
function clear() {
  active = undefined;
  clearTimeout(slowTimer);
  display();
}

document.addEventListener('astro:before-preparation', (raw) => {
  const event = raw as TransitionBeforePreparationEvent;
  const current = Symbol();
  active = current;
  clearTimeout(slowTimer);
  display('正在加载页面…');
  slowTimer = setTimeout(() => {
    if (active === current) display('页面加载较慢，请稍候；也可以选择其他页面。');
  }, 8000);
  const abort = () => { if (active === current) clear(); };
  event.signal.addEventListener('abort', abort, { once: true });
  const load = event.loader;
  event.loader = async () => {
    try {
      await load();
    } catch (error) {
      if (active === current) {
        clear();
        display('页面加载失败，请重试或刷新页面。');
      }
      throw error;
    } finally {
      event.signal.removeEventListener('abort', abort);
      if (active === current && (event.defaultPrevented || event.signal.aborted)) clear();
    }
  };
});
// 交换后即移除反馈；无需等待新页面所有脚本初始化完成。
document.addEventListener('astro:after-swap', clear);
document.addEventListener('astro:page-load', clear);
window.addEventListener('pageshow', clear);
