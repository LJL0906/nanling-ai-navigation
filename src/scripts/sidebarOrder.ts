import { MENU_ORDER_KEY, normalizeMenuOrder, readMenuOrder, saveMenuOrder } from '../lib/menu-order';

let dispose: (() => void) | undefined;
const defaultOrders = new WeakMap<HTMLElement, string[]>();

function initSidebarOrder() {
  dispose?.();
  dispose = undefined;
  const list = document.querySelector<HTMLElement>('[data-menu-order]');
  const scroller = document.querySelector<HTMLElement>('[data-menu-scroll]');
  const status = document.querySelector<HTMLElement>('[data-menu-status]');
  if (!list || !scroller || !status) return;
  const items = Array.from(list.querySelectorAll<HTMLElement>('[data-menu-id]'));
  const defaults = defaultOrders.get(list) ?? normalizeMenuOrder(items.map((item) => item.dataset.menuId!), null);
  defaultOrders.set(list, defaults);
  const nodes = new Map(items.map((item) => [item.dataset.menuId!, item]));
  const controller = new AbortController();
  const options = { signal: controller.signal };
  // 延迟访问 localStorage，让禁用存储的浏览器仍能使用菜单和临时排序。
  const storage = {
    getItem: (key: string) => localStorage.getItem(key),
    setItem: (key: string, value: string) => localStorage.setItem(key, value),
  };
  let drag: {
    item: HTMLElement; handle: HTMLButtonElement; pointerId: number;
    startX: number; startY: number; x: number; y: number;
    original: string[]; active: boolean;
  } | undefined;
  let frame = 0;
  const order = () => Array.from(list.children, (item) => (item as HTMLElement).dataset.menuId!);
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
  function notifyOrder() {
    document.dispatchEvent(new CustomEvent('nav:menu-order-change', { detail: order() }));
  }
  function apply(ids: string[]) {
    for (const id of normalizeMenuOrder(defaults, ids)) list!.append(nodes.get(id)!);
    notifyOrder();
  }
  function announce(message: string, error = false) {
    status!.textContent = message;
    status!.toggleAttribute('data-error', error);
  }
  function persist(message: string) {
    const saved = saveMenuOrder(storage, order());
    notifyOrder();
    announce(saved ? message : '顺序已调整，但浏览器存储不可用，刷新后可能丢失。', !saved);
  }
  // 先完成实际菜单的个人排序，再在同一帧显示，避免默认顺序闪现。
  apply(readMenuOrder(storage, defaults));
  list.toggleAttribute('data-menu-pending', false);
  const loading = document.querySelector<HTMLElement>('[data-menu-list-loading]');
  if (loading) loading.hidden = true;

  function moveAtPointer() {
    if (!drag?.active) return;
    const bounds = scroller!.getBoundingClientRect();
    if (drag.x < bounds.left || drag.x > bounds.right) return;
    const others = Array.from(list!.children).filter((item) => item !== drag!.item && (item as HTMLElement).dataset.menuId !== '/');
    const before = others.find((item) => {
      const rect = item.getBoundingClientRect();
      return drag!.y < rect.top + rect.height / 2;
    }) ?? null;
    if (drag.item.nextElementSibling !== before) list!.insertBefore(drag.item, before);
  }
  function autoScroll() {
    if (!drag?.active) return;
    const rect = scroller!.getBoundingClientRect();
    if (drag.x >= rect.left && drag.x <= rect.right) {
      const edge = 44;
      const speed = drag.y < rect.top + edge ? -Math.min(12, (rect.top + edge - drag.y) / 3)
        : drag.y > rect.bottom - edge ? Math.min(12, (drag.y - rect.bottom + edge) / 3) : 0;
      if (speed) {
        scroller!.scrollTop += speed;
        moveAtPointer();
      }
    }
    frame = requestAnimationFrame(autoScroll);
  }
  function finish(cancel = false) {
    if (!drag) return;
    const ended = drag;
    drag = undefined;
    cancelAnimationFrame(frame);
    frame = 0;
    ended.item.classList.remove('is-dragging');
    list!.classList.remove('is-sorting');
    if (list!.hasPointerCapture(ended.pointerId)) list!.releasePointerCapture(ended.pointerId);
    if (cancel) {
      apply(ended.original);
      if (ended.active) announce('已取消拖动，顺序未保存。');
    } else if (ended.active && !same(order(), ended.original)) {
      persist(`菜单顺序已保存，当前位置第 ${order().indexOf(ended.item.dataset.menuId!) + 1} 项。`);
    }
    ended.handle.focus({ preventScroll: true });
  }

  list.addEventListener('pointerdown', (event) => {
    const handle = (event.target as Element).closest<HTMLButtonElement>('[data-menu-handle]');
    if (!handle || drag || event.button !== 0 || !event.isPrimary) return;
    const item = handle.closest<HTMLElement>('[data-menu-id]');
    if (!item || item.dataset.menuId === '/') return;
    event.preventDefault();
    handle.focus({ preventScroll: true });
    drag = { item, handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, original: order(), active: false };
    // 捕获在不参与重排的列表上，避免移动行节点时丢失触屏事件。
    list.setPointerCapture(event.pointerId);
  }, options);
  list.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
      drag.active = true;
      drag.item.classList.add('is-dragging');
      list.classList.add('is-sorting');
      frame = requestAnimationFrame(autoScroll);
    }
    moveAtPointer();
  }, options);
  list.addEventListener('pointerup', (event) => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const rect = scroller.getBoundingClientRect();
    finish(event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
  }, options);
  list.addEventListener('pointercancel', (event) => {
    if (event.pointerId === drag?.pointerId) finish(true);
  }, options);
  list.addEventListener('lostpointercapture', (event) => {
    if (event.pointerId === drag?.pointerId) finish(true);
  }, options);
  list.addEventListener('click', (event) => {
    if ((event.target as Element).closest('[data-menu-handle]')) event.preventDefault();
  }, options);
  list.addEventListener('keydown', (event) => {
    const handle = (event.target as Element).closest<HTMLButtonElement>('[data-menu-handle]');
    if (!handle || drag) return;
    const item = handle.closest<HTMLElement>('[data-menu-id]')!;
    if (item.dataset.menuId === '/') return;
    const ids = order();
    const firstMovable = ids[0] === '/' ? 1 : 0;
    const from = ids.indexOf(item.dataset.menuId!);
    let to = from;
    if (event.key === 'ArrowUp') to = Math.max(firstMovable, from - 1);
    else if (event.key === 'ArrowDown') to = Math.min(ids.length - 1, from + 1);
    else if (event.key === 'Home') to = firstMovable;
    else if (event.key === 'End') to = ids.length - 1;
    else return;
    event.preventDefault();
    if (from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, item.dataset.menuId!);
    apply(ids);
    handle.focus({ preventScroll: true });
    item.scrollIntoView({ block: 'nearest' });
    persist(`菜单顺序已保存，当前位置第 ${to + 1} 项，共 ${ids.length} 项。`);
  }, options);
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !drag) return;
    event.preventDefault();
    event.stopPropagation();
    finish(true);
  }, { ...options, capture: true });
  window.addEventListener('blur', () => finish(true), options);
  window.addEventListener('storage', (event) => {
    if ((event.key !== MENU_ORDER_KEY && event.key !== null) || drag) return;
    apply(readMenuOrder(storage, defaults));
  }, options);
  dispose = () => { finish(true); controller.abort(); };
}

document.addEventListener('astro:page-load', initSidebarOrder);
document.addEventListener('astro:before-swap', () => { dispose?.(); dispose = undefined; });
initSidebarOrder();

