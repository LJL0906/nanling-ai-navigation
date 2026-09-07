const KEY = 'nav-search-history';
const MAX_ITEMS = 5;
type Destinations = Record<string, string | null>;
let destinationsPromise: Promise<Destinations> | undefined;

function readHistory(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_ITEMS) : [];
  } catch { return []; }
}

function writeHistory(items: string[]) {
  try { localStorage.setItem(KEY, JSON.stringify(items.slice(0, MAX_ITEMS))); }
  catch { /* 存储受限时不阻止正常搜索。 */ }
}

function loadDestinations() {
  destinationsPromise ??= fetch('/history-destinations.json', { signal: AbortSignal.timeout(3000) })
    .then((response) => {
      if (!response.ok) throw new Error('无法加载历史链接索引');
      return response.json() as Promise<Destinations>;
    })
    .catch((error: unknown) => { destinationsPromise = undefined; throw error; });
  return destinationsPromise;
}

function initSearchHistory() {
  const form = document.querySelector<HTMLFormElement>('[data-search-history-form]');
  const scope = form?.closest('[data-nav-search]') ?? document;
  const input = form?.querySelector<HTMLInputElement>('input[name="q"]');
  const container = scope.querySelector<HTMLElement>('[data-search-history]');
  const tags = scope.querySelector<HTMLElement>('[data-search-history-tags]');
  const empty = scope.querySelector<HTMLElement>('[data-search-history-empty]');
  const popover = scope.querySelector<HTMLDetailsElement>('[data-history-popover]');
  if (!form || !input || !container || !tags || form.dataset.searchHistoryReady === 'true') return;
  form.dataset.searchHistoryReady = 'true';
  let destinations: Destinations = {};
  let loaded = false;
  let loading = false;
  if (tags.dataset.historyDestinations) {
    try { destinations = JSON.parse(tags.dataset.historyDestinations); loaded = true; } catch { /* 旧组件兜底。 */ }
  }

  function resolveHref(word: string): string | null {
    const key = word.trim().toLowerCase().replace(/\/$/, '');
    const matchedUrl = Object.hasOwn(destinations, key) ? destinations[key] : null;
    const candidate = matchedUrl ?? word.trim();
    try {
      const explicitUrl = /^https?:\/\//i.test(candidate);
      const domain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(candidate);
      if (explicitUrl || domain) {
        const url = new URL(explicitUrl ? candidate : `https://${candidate}`);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href;
      }
    } catch { /* 未明确匹配的关键词不猜测跳转地址。 */ }
    return null;
  }

  function render() {
    const history = readHistory();
    const items = history.flatMap((word) => {
      const href = resolveHref(word);
      return href ? [{ word, href }] : [];
    });
    // 索引未加载或请求失败时，只隐藏未确认的记录，不误删已有站点词。
    if (loaded && items.length !== history.length) writeHistory(items.map(({ word }) => word));
    tags!.replaceChildren(...items.map(({ word, href }) => {
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'cyber-search-history__tag';
      link.textContent = word;
      link.title = `访问 ${word}（新窗口打开）`;
      return link;
    }));
    container!.hidden = items.length === 0;
    if (empty) empty.hidden = items.length !== 0;
  }

  async function refresh() {
    render();
    if (loaded || loading || readHistory().length === 0) return;
    loading = true;
    try {
      destinations = await loadDestinations();
      loaded = true;
      if (form!.isConnected) render();
    } catch { /* 网络失败时保留记录，下一次打开浮层重试。 */ }
    finally { loading = false; }
  }

  let resumingSubmit = false;
  let submitting = false;
  form.addEventListener('submit', async (event) => {
    if (resumingSubmit || event.defaultPrevented) return;
    if (submitting) {
      event.preventDefault();
      return;
    }
    const word = input.value.trim();
    if (!word) {
      event.preventDefault();
      input.focus();
      return;
    }
    input.value = word;
    const needsIndex = !loaded && !resolveHref(word);
    if (needsIndex) {
      event.preventDefault();
      submitting = true;
      try {
        destinations = await loadDestinations();
        loaded = true;
      } catch { /* 无法确认链接时不保存关键词，仍继续正常搜索。 */ }
      finally { submitting = false; }
      if (!form.isConnected) return;
    }
    // 等待索引期间用户可能修改输入；只记录实际将要提交的词。
    const submittedWord = input.value.trim();
    if (resolveHref(submittedWord)) {
      writeHistory([submittedWord, ...readHistory().filter((item) =>
        item !== submittedWord && (!loaded || resolveHref(item) !== null))]);
    }
    render();
    if (needsIndex) {
      resumingSubmit = true;
      try { form.requestSubmit(event.submitter); }
      finally { resumingSubmit = false; }
    }
  });
  popover?.addEventListener('toggle', () => { if (popover.open) void refresh(); });
  popover?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      popover.open = false;
      popover.querySelector('summary')?.focus();
    }
  });
  void refresh();
}

document.addEventListener('astro:page-load', initSearchHistory);
initSearchHistory();

