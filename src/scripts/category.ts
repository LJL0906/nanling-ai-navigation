/** 筛选与分页由服务端按 URL 渲染；这里只增强分类栏的横向滚动。 */
let pendingTabsScroll: { category: string; left: number } | undefined;
let disposeCategory: (() => void) | undefined;

function saveTabsScroll() {
  const tabs = document.querySelector<HTMLElement>('[data-category-tabs]');
  pendingTabsScroll = tabs?.dataset.categoryTabs
    ? { category: tabs.dataset.categoryTabs, left: tabs.scrollLeft }
    : undefined;
}

function restoreTabsScroll() {
  const tabs = document.querySelector<HTMLElement>('[data-category-tabs]');
  if (tabs && pendingTabsScroll && pendingTabsScroll.category === tabs.dataset.categoryTabs) {
    tabs.scrollLeft = pendingTabsScroll.left;
  }
}

function initCategory() {
  disposeCategory?.();
  restoreTabsScroll();
  pendingTabsScroll = undefined;
  const root = document.querySelector<HTMLElement>('[data-category-page]');
  if (!root) return;
  const list = root.querySelector<HTMLElement>('[data-category-sites]');
  const label = root.querySelector<HTMLElement>('[data-results-label]')?.textContent;
  if (list && label) list.setAttribute('aria-label', `${label}站点列表`);

  const bar = root.querySelector<HTMLElement>('.category-tabbar');
  const tabs = root.querySelector<HTMLElement>('[data-category-tabs]');
  const previous = root.querySelector<HTMLButtonElement>('[data-category-tabs-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-category-tabs-next]');
  if (!bar || !tabs || !previous || !next) return;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const behavior = (): ScrollBehavior => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  const sync = () => {
    const style = getComputedStyle(bar);
    const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    previous.hidden = next.hidden = tabs.scrollWidth <= available + 1;
    previous.disabled = tabs.scrollLeft <= 1;
    next.disabled = tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 1;
  };
  const reveal = (tab: HTMLElement | null, motion: ScrollBehavior) => {
    if (!tab) return;
    const viewport = tabs.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    const left = target.left < viewport.left ? target.left - viewport.left
      : target.right > viewport.right ? target.right - viewport.right : 0;
    // 不使用 scrollIntoView，避免切换时带动整页纵向跳动。
    if (left) tabs.scrollBy({ left, behavior: motion });
  };
  previous.addEventListener('click', () => tabs.scrollBy({ left: -tabs.clientWidth * .75, behavior: behavior() }), options);
  next.addEventListener('click', () => tabs.scrollBy({ left: tabs.clientWidth * .75, behavior: behavior() }), options);
  tabs.addEventListener('scroll', sync, { ...options, passive: true });
  tabs.addEventListener('focusin', (event) => {
    reveal((event.target as HTMLElement).closest<HTMLElement>('[data-category-tab]'), behavior());
  }, options);
  const observer = new ResizeObserver(() => {
    sync();
    reveal(tabs.querySelector<HTMLElement>('[aria-current="true"]'), 'instant');
    sync();
  });
  observer.observe(bar);
  observer.observe(tabs);
  sync();
  reveal(tabs.querySelector<HTMLElement>('[aria-current="true"]'), 'instant');
  sync();
  disposeCategory = () => {
    controller.abort();
    observer.disconnect();
    disposeCategory = undefined;
  };
}

// 必须在旧 DOM 被替换前读取；新 DOM 挂载后再赋值。
document.addEventListener('astro:before-swap', () => {
  saveTabsScroll();
  disposeCategory?.();
});
document.addEventListener('astro:after-swap', restoreTabsScroll);
document.addEventListener('astro:page-load', initCategory);
initCategory();
