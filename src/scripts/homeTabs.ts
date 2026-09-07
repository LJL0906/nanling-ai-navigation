/** 首页分类栏仅负责滚动，不改变分类选择或站点数据。 */
export function initHomeTabs(element: HTMLElement, signal: AbortSignal) {
  const tabs = element.querySelector<HTMLElement>('.home-section-tabs')!;
  const previous = element.querySelector<HTMLButtonElement>('[data-home-tabs-prev]')!;
  const next = element.querySelector<HTMLButtonElement>('[data-home-tabs-next]')!;
  const bar = element.querySelector<HTMLElement>('.home-section-tabbar')!;
  const options = { signal };
  const behavior = (): ScrollBehavior => matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  const sync = () => {
    // 用栏内总宽判断，避免按钮挤占空间导致溢出误判或滚动位置跳动。
    const style = getComputedStyle(bar);
    const available = bar.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    const overflowing = tabs.scrollWidth > available + 1;
    previous.hidden = next.hidden = !overflowing;
    previous.disabled = tabs.scrollLeft <= 1;
    next.disabled = tabs.scrollLeft + tabs.clientWidth >= tabs.scrollWidth - 1;
  };
  const scroll = (direction: number) => tabs.scrollBy({ left: direction * tabs.clientWidth * .75, behavior: behavior() });
  previous.addEventListener('click', () => scroll(-1), options);
  next.addEventListener('click', () => scroll(1), options);
  tabs.addEventListener('scroll', sync, { ...options, passive: true });
  tabs.addEventListener('focusin', (event) => {
    const tab = (event.target as HTMLElement).closest<HTMLElement>('[data-home-tab]');
    if (!tab) return;
    const viewport = tabs.getBoundingClientRect();
    const target = tab.getBoundingClientRect();
    const left = target.left < viewport.left ? target.left - viewport.left
      : target.right > viewport.right ? target.right - viewport.right : 0;
    if (left) tabs.scrollBy({ left, behavior: behavior() });
  }, options);
  const observer = new ResizeObserver(sync);
  observer.observe(bar);
  observer.observe(tabs);
  sync();
  return () => observer.disconnect();
}
