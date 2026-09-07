/** 主题切换：写入 localStorage 并同步 <html> 上的 .dark 类。 */
const KEY = 'nav-theme';

type Theme = 'light' | 'dark';

function apply(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.querySelectorAll<HTMLElement>('[data-theme-toggle]').forEach((el) => {
    el.setAttribute('aria-pressed', String(theme === 'dark'));
  });
}

function current(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function setTheme(theme: Theme) {
  localStorage.setItem(KEY, theme);
  apply(theme);
}

export function initTheme() {
  apply(current());

  // 点击切换：data-set-theme 指定目标主题，data-theme-toggle 为反转当前值
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    const explicit = target?.closest<HTMLElement>('[data-set-theme]');
    if (explicit) {
      setTheme(explicit.dataset.setTheme === 'dark' ? 'dark' : 'light');
      return;
    }
    if (target?.closest('[data-theme-toggle]')) {
      setTheme(current() === 'dark' ? 'light' : 'dark');
    }
  });
}
