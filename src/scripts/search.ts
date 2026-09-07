import { isValidSiteId } from '../lib/site-id.ts';
import { appendSiteImage } from './site-icons.ts';
import type { SearchIndex } from '../pages/search-index.json';

/** 仅克隆服务端提供的品牌 glyph，保留卡片图标容器及站点颜色。 */
export function appendSearchBrandIcon(
  icon: HTMLElement, value: unknown, templates: Map<string, HTMLTemplateElement>, color: string,
): boolean {
  if (typeof value !== 'string') return false;
  const source = templates.get(value)?.content.querySelector('svg');
  if (!source) return false;
  const glyph = source.cloneNode(true) as SVGElement;
  glyph.style.color = color;
  icon.replaceChildren(glyph);
  return true;
}

export const PAGE_SIZE = 48;
type SearchEntry = SearchIndex['sites'][number] & {
  categorySlug: string;
  categoryName: string;
  haystack: string;
  normalizedName: string;
};

export function normalizeQuery(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/** 校验版本及最小展示契约，错误响应统一进入可重试状态。 */
export function prepareIndex(value: unknown): SearchEntry[] {
  const index = value as SearchIndex | null;
  if (index?.version !== 1 || !Array.isArray(index.categories) || !Array.isArray(index.sites)) {
    throw new Error('无效的搜索索引');
  }
  for (const category of index.categories) {
    if (!category || typeof category.slug !== 'string' || typeof category.name !== 'string') {
      throw new Error('无效的搜索分类');
    }
  }
  return index.sites.map((site) => {
    if (!site || !['id', 'url', 'slug', 'name', 'desc', 'color', 'terms'].every(
      (key) => typeof site[key as keyof typeof site] === 'string',
    ) || !Number.isInteger(site.category) || !index.categories[site.category]) {
      throw new Error('无效的搜索条目');
    }
    const destination = new URL(site.url);
    if (!isValidSiteId(site.id) || !['http:', 'https:'].includes(destination.protocol)
      || destination.username || destination.password) throw new Error('无效的搜索站点链接');
    const category = index.categories[site.category];
    return {
      ...site,
      categorySlug: category.slug,
      categoryName: category.name,
      normalizedName: normalizeQuery(site.name),
      haystack: normalizeQuery([site.name, site.desc, site.slug, category.name, category.slug, site.terms].join('\n')),
    };
  });
}

/** 多个空白分隔词取交集；名称精确匹配优先，其余保留数据层顺序。 */
export function findMatches(entries: SearchEntry[], raw: string): SearchEntry[] {
  const query = normalizeQuery(raw);
  if (!query) return entries;
  const words = query.split(/\s+/u);
  const matches = entries.filter((entry) => words.every((word) => entry.haystack.includes(word)));
  return matches.sort((a, b) => Number(b.normalizedName === query) - Number(a.normalizedName === query));
}

export function paginate<T>(entries: T[], requestedPage: number) {
  const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Number.isSafeInteger(requestedPage) ? requestedPage : 1));
  return { page, totalPages, items: entries.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) };
}

// 成功结果以及进行中的请求在 Astro 页面切换间共享；失败后允许显式重试。
let indexPromise: Promise<SearchEntry[]> | undefined;
function loadIndex(): Promise<SearchEntry[]> {
  if (!indexPromise) {
    indexPromise = fetch('/search-index.json', { credentials: 'same-origin', mode: 'same-origin', redirect: 'error' })
      .then((response) => {
        if (!response.ok) throw new Error(`搜索索引响应异常：${response.status}`);
        return response.json();
      })
      .then(prepareIndex)
      .catch((error: unknown) => {
        indexPromise = undefined;
        throw error;
      });
  }
  return indexPromise;
}

let active: { root: HTMLElement; dispose: () => void; sync: () => void } | undefined;

function initSearch() {
  const root = document.querySelector<HTMLElement>('[data-search-root]');
  if (root && active?.root === root) {
    active.sync();
    return;
  }
  active?.dispose();
  active = undefined;
  if (!root) return;

  const input = root.querySelector<HTMLInputElement>('[data-search-input]')!;
  const form = root.querySelector<HTMLFormElement>('[data-search-form]')!;
  const summary = root.querySelector<HTMLElement>('[data-search-summary]')!;
  const list = root.querySelector<HTMLUListElement>('[data-search-list]')!;
  const template = root.querySelector<HTMLTemplateElement>('[data-search-template]')!;
  const brandIcons = new Map(Array.from(root.querySelectorAll<HTMLTemplateElement>('template[data-search-brand-icon]'))
    .map((icon) => [icon.dataset.searchBrandIcon!, icon]));
  const empty = root.querySelector<HTMLElement>('[data-search-empty]')!;
  const error = root.querySelector<HTMLElement>('[data-search-error]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-search-retry]')!;
  const pagination = root.querySelector<HTMLElement>('[data-search-pagination]')!;
  const pageLabel = root.querySelector<HTMLElement>('[data-search-page]')!;
  const previous = root.querySelector<HTMLButtonElement>('[data-search-prev]')!;
  const next = root.querySelector<HTMLButtonElement>('[data-search-next]')!;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let disposed = false;
  let loading = false;
  let entries: SearchEntry[] | undefined;
  let page = 1;
  let urlTimer: ReturnType<typeof setTimeout> | undefined;

  function syncURL() {
    clearTimeout(urlTimer);
    if (disposed || !root?.isConnected) return;
    const url = new URL(location.href);
    const query = input.value.trim();
    if (query) url.searchParams.set('q', query);
    else url.searchParams.delete('q');
    if (page > 1) url.searchParams.set('page', String(page));
    else url.searchParams.delete('page');
    // 保留 Astro ClientRouter 的历史状态与其它查询参数/锚点。
    if (url.href !== location.href) history.replaceState(history.state, '', url);
  }

  function render() {
    if (disposed || !root?.isConnected || !entries) return;
    const matches = findMatches(entries, input.value);
    const result = paginate(matches, page);
    page = result.page;
    const fragment = document.createDocumentFragment();
    for (const entry of result.items) {
      const card = template.content.cloneNode(true) as DocumentFragment;
      card.querySelector<HTMLElement>('[data-site-id]')!.dataset.siteId = entry.id;
      const favorite = card.querySelector<HTMLButtonElement>('[data-favorite-id]')!;
      favorite.dataset.favoriteId = entry.id;
      favorite.dataset.siteName = entry.name;
      const external = card.querySelector<HTMLAnchorElement>('[data-result-external]')!;
      external.href = entry.url;
      external.setAttribute('aria-label', `直达 ${entry.name} 官网（新窗口打开）`);
      const name = card.querySelector<HTMLAnchorElement>('[data-result-name]')!;
      const description = card.querySelector<HTMLElement>('[data-result-desc]')!;
      const category = card.querySelector<HTMLAnchorElement>('[data-result-category]')!;
      const icon = card.querySelector<HTMLElement>('.search-result-icon')!;
      const glyph = icon.querySelector<HTMLElement>('span')!;
      const categoryPath = `/${encodeURIComponent(entry.categorySlug)}/`;
      name.textContent = entry.name;
      name.href = entry.url;
      name.setAttribute('aria-label', `直达 ${entry.name} 官网（新窗口打开）`);
      name.title = entry.name;
      description.textContent = entry.desc;
      description.title = entry.desc;
      category.textContent = entry.categoryName;
      category.title = entry.categoryName;
      category.href = categoryPath;
      // 品牌 SVG 仅来自本地模板；其它值沿用本地图像校验和首字回退，不请求外站。
      const color = /^#[\da-f]{6}$/i.test(entry.color) ? entry.color : '#3777f5';
      icon.style.backgroundColor = `${color}1f`;
      glyph.style.color = color;
      glyph.textContent = typeof entry.mono === 'string' && entry.mono ? entry.mono : Array.from(entry.name.trim())[0] || '?';
      if (!appendSearchBrandIcon(icon, entry.icon, brandIcons, color)) appendSiteImage(icon, entry.icon);
      fragment.append(card);
    }
    list.replaceChildren(fragment);
    list.setAttribute('aria-busy', 'false');
    const query = input.value.trim();
    const count = query ? `“${query}” 匹配到 ${matches.length} 个站点` : `共 ${matches.length} 个站点`;
    const start = (page - 1) * PAGE_SIZE + 1;
    summary.textContent = matches.length ? `${count}，显示第 ${start}–${start + result.items.length - 1} 条` : count;
    empty.classList.toggle('hidden', matches.length > 0);
    error.classList.add('hidden');
    pagination.classList.toggle('hidden', result.totalPages <= 1);
    previous.disabled = page <= 1;
    next.disabled = page >= result.totalPages;
    pageLabel.textContent = `第 ${page} / ${result.totalPages} 页`;
  }

  function syncFromURL() {
    clearTimeout(urlTimer);
    const params = new URLSearchParams(location.search);
    input.value = params.get('q') ?? '';
    const requestedPage = Number(params.get('page') ?? 1);
    page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    render();
  }

  async function startLoading() {
    if (loading) return;
    loading = true;
    list.replaceChildren();
    list.setAttribute('aria-busy', 'true');
    summary.textContent = '正在加载搜索索引…';
    empty.classList.add('hidden');
    error.classList.add('hidden');
    pagination.classList.add('hidden');
    try {
      const loaded = await loadIndex();
      // 离开页面后，不让旧请求写入已被替换的 DOM 或新页面状态。
      if (disposed || !root?.isConnected) return;
      entries = loaded;
      render();
    } catch {
      if (disposed || !root?.isConnected) return;
      list.setAttribute('aria-busy', 'false');
      summary.textContent = '暂时无法搜索站点';
      error.classList.remove('hidden');
    } finally {
      loading = false;
    }
  }

  function onInput() {
    page = 1;
    render();
    clearTimeout(urlTimer);
    urlTimer = setTimeout(syncURL, 180);
  }

  input.addEventListener('input', (event) => {
    if (!(event as InputEvent).isComposing) onInput();
  }, options);
  input.addEventListener('compositionend', onInput, options);
  input.addEventListener('change', syncURL, options);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    page = 1;
    render();
    syncURL();
  }, options);
  previous.addEventListener('click', () => {
    page -= 1;
    render();
    syncURL();
  }, options);
  next.addEventListener('click', () => {
    page += 1;
    render();
    syncURL();
  }, options);
  retry.addEventListener('click', () => { void startLoading(); }, options);

  active = {
    root,
    sync: syncFromURL,
    dispose: () => {
      disposed = true;
      clearTimeout(urlTimer);
      controller.abort();
    },
  };
  syncFromURL();
  void startLoading();
}

// Astro 的脚本只执行一次；每次导航重新初始化，旧元素监听器统一清理。
document.addEventListener('astro:page-load', initSearch);
document.addEventListener('astro:before-swap', () => {
  active?.dispose();
  active = undefined;
});
window.addEventListener('popstate', () => {
  if (/^\/search\/?$/.test(location.pathname)) active?.sync();
});
initSearch();
