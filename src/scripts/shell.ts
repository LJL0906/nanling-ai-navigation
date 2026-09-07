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

/** 一次只展开一个下拉，点击外部或按 Esc 收起。 */
function initDropdowns() {
  const all = () => Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-dropdown]'));

  document.addEventListener('toggle', (e) => {
    const d = e.target as HTMLDetailsElement;
    if (!d.matches?.('details[data-dropdown]') || !d.open) return;
    all().forEach((other) => {
      if (other !== d) other.open = false;
    });
  }, true);

  document.addEventListener('click', (e) => {
    const el = e.target as HTMLElement | null;
    if (el?.closest('details[data-dropdown]')) return;
    all().forEach((d) => (d.open = false));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') all().forEach((d) => (d.open = false));
  });
}

export function initShell() {
  initDrawer();
  initDropdowns();
}
