/** 移动端抽屉与顶部下拉菜单的交互逻辑。 */

function initDrawer() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  const setOpen = (open: boolean) => {
    document.documentElement.classList.toggle('drawer-open', open);
    document.querySelectorAll<HTMLElement>('[data-drawer-open]').forEach((btn) => {
      btn.setAttribute('aria-expanded', String(open));
    });
  };

  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('[data-drawer-open]')) return setOpen(true);
    if (el?.closest('[data-drawer-close]')) return setOpen(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}

/** 一次只展开一个下拉，离开菜单时收起，Esc 返回对应触发器。 */
function initDropdowns() {
  const all = () => Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-dropdown]'));
  const closeOthers = (current?: HTMLDetailsElement) => {
    all().forEach((dropdown) => {
      if (dropdown !== current) dropdown.open = false;
    });
  };

  document.addEventListener('toggle', (event) => {
    const dropdown = event.target;
    if (!(dropdown instanceof HTMLDetailsElement) || !dropdown.matches('[data-dropdown]') || !dropdown.open) return;
    closeOthers(dropdown);
  }, true);

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const dropdown = event.target.closest<HTMLDetailsElement>('details[data-dropdown]');
    closeOthers(dropdown ?? undefined);
    // 外链打开后也收起面板；焦点回到仍可见的触发器。
    if (dropdown && event.target.closest('a[href]')) {
      dropdown.open = false;
      dropdown.querySelector('summary')?.focus({ preventScroll: true });
    }
  });

  document.addEventListener('focusin', (event) => {
    if (!(event.target instanceof Element)) return;
    closeOthers(event.target.closest<HTMLDetailsElement>('details[data-dropdown]') ?? undefined);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const opened = all().find((dropdown) => dropdown.open);
    if (!opened) return;
    event.preventDefault();
    closeOthers();
    opened.querySelector('summary')?.focus({ preventScroll: true });
  });
}

/** 顶部透明，滚动后启用毛玻璃；页面切换及历史位置恢复时同步状态。 */
function initTopbarScroll() {
  const sync = () => {
    document.querySelector('.cyber-topbar')?.classList.toggle('is-scrolled', window.scrollY > 0);
  };

  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('pageshow', sync);
  document.addEventListener('astro:page-load', sync);
  sync();
}

export function initShell() {
  initTopbarScroll();
  initDrawer();
  initDropdowns();
}
