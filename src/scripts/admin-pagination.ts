export type AdminPageState = { page: number; totalPages: number; total: number; pageSize: number; busy?: boolean };

/** 统一分页页码窗口：保留首尾及当前页两侧，省略不连续区间。 */
export function adminPageNumbers(page: number, totalPages: number): (number | 'ellipsis')[] {
  const total = Math.max(1, Math.floor(totalPages));
  const current = Math.max(1, Math.min(total, Math.floor(page)));
  const numbers = total <= 7 ? Array.from({ length: total }, (_, i) => i + 1)
    : [...new Set([1, total, ...Array.from({ length: 5 }, (_, i) => Math.max(2, Math.min(total - 5, current - 2)) + i)])].sort((a, b) => a - b);
  const result: (number | 'ellipsis')[] = [];
  for (const number of numbers) {
    const previous = result.at(-1);
    if (typeof previous === 'number' && number - previous > 1) result.push('ellipsis');
    result.push(number);
  }
  return result;
}
export function bindAdminPagination(root: HTMLElement, onChange: (page: number) => void) {
  const controller = new AbortController();
  const options = { signal: controller.signal };
  root.classList.add('admin-pagination');
  const next = root.querySelector<HTMLButtonElement>('[data-admin-next], #review-next, #menu-next, [data-announcement-next]');
  const host = next?.parentElement ?? root;
  host.classList.add('admin-pagination-actions');
  const numbers = document.createElement('span'); numbers.className = 'admin-page-numbers'; numbers.dataset.pageNumbers = '';
  numbers.setAttribute('role', 'group'); numbers.setAttribute('aria-label', '选择页码');
  host.insertBefore(numbers, next ?? null);
  const jump = document.createElement('span'); jump.className = 'admin-page-jump';
  const label = document.createElement('label'); label.append(document.createTextNode('前往'));
  const input = document.createElement('input'); input.type = 'number'; input.min = '1'; input.step = '1'; input.inputMode = 'numeric';
  input.dataset.pageJump = ''; input.setAttribute('aria-label', '跳转页码');
  label.append(input, document.createTextNode('页'));
  const go = document.createElement('button'); go.type = 'button'; go.textContent = '跳转'; go.dataset.pageGo = '';
  jump.append(label, go); host.append(jump);
  let state: AdminPageState = { page: 1, totalPages: 1, total: 0, pageSize: 10, busy: true };
  function navigate(page: number) { if (!state.busy && state.total > 0 && page !== state.page && page >= 1 && page <= state.totalPages) onChange(page); }
  function goTo() {
    if (state.busy) return;
    const raw = input.value.trim(); const value = Number(raw);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(value) || value > state.totalPages) {
      input.setCustomValidity(`请输入 1–${state.totalPages} 的整数页码。`); input.reportValidity(); return;
    }
    input.setCustomValidity(''); navigate(value);
  }
  numbers.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button[data-page]') : null;
    if (target && !target.disabled) navigate(Number(target.dataset.page));
  }, options);
  go.addEventListener('click', goTo, options);
  input.addEventListener('input', () => input.setCustomValidity(''), options);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); goTo(); } }, options);
  function update(nextState: AdminPageState) {
    state = { ...nextState, totalPages: Math.max(1, nextState.totalPages) };
    state.page = Math.max(1, Math.min(state.totalPages, state.page));
    numbers.replaceChildren();
    for (const page of adminPageNumbers(state.page, state.totalPages)) {
      if (page === 'ellipsis') { const span = document.createElement('span'); span.textContent = '…'; span.setAttribute('aria-hidden', 'true'); numbers.append(span); continue; }
      const button = document.createElement('button'); button.type = 'button'; button.dataset.page = String(page); button.textContent = String(page);
      button.setAttribute('aria-label', `第 ${page} 页`);
      if (page === state.page) button.setAttribute('aria-current', 'page');
      button.disabled = !!state.busy || state.total === 0;
      numbers.append(button);
    }
    input.max = String(state.totalPages); input.value = String(state.page); input.setCustomValidity('');
    input.disabled = go.disabled = !!state.busy || state.total === 0;
  }
  update(state);
  return { update, destroy: () => { controller.abort(); numbers.remove(); jump.remove(); } };
}
