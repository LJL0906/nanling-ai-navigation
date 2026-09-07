import { createPersonalApi, LoginRequiredError, requestPersonalAuth } from './personal-api';
import { loadPersonalSites } from './personal-catalog';

export const PERSONAL_CHANGED = 'nav:personal-changed';
let channel: BroadcastChannel | undefined;
try { channel = new BroadcastChannel('nav:personal-api'); } catch { /* 聚焦时仍重新读取。 */ }
export const personalStore = createPersonalApi({
  fetch: (...args) => fetch(...args),
  storage: {
    getItem: (key) => localStorage.getItem(key),
    // 本地仓库仅用于迁移读取，运行期禁止新增本地收藏或历史。
    setItem: () => { throw new Error('个人记录必须登录后保存到服务器'); },
    removeItem: (key) => localStorage.removeItem(key),
  },
  changed: () => document.dispatchEvent(new CustomEvent(PERSONAL_CHANGED)),
  broadcast: () => channel?.postMessage('changed'),
});
let noticeTimer: ReturnType<typeof setTimeout>;
export function notifyPersonal(message: string) {
  let notice = document.querySelector<HTMLElement>('[data-personal-notice]');
  if (!notice) {
    notice = document.createElement('div');
    notice.dataset.personalNotice = '';
    notice.className = 'personal-notice';
    notice.setAttribute('role', 'status');
    document.body.append(notice);
  }
  notice.textContent = message;
  notice.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { if (notice) notice.hidden = true; }, 5000);
}
export function personalError(cause: unknown, reason: 'favorite' | 'personal' = 'personal') {
  if (cause instanceof LoginRequiredError) requestPersonalAuth(reason);
  else notifyPersonal(cause instanceof Error ? cause.message : '操作失败，请重试。');
}
function syncStars(root: ParentNode = document) {
  const state = personalStore.snapshot();
  const selected = new Set(state.data.favorites.map((item) => item.siteId));
  root.querySelectorAll<HTMLButtonElement>('[data-favorite-id]').forEach((button) => {
    const saved = selected.has(button.dataset.favoriteId ?? '');
    const label = `${saved ? '取消收藏' : '收藏'} ${button.dataset.siteName ?? '站点'}`;
    button.setAttribute('aria-pressed', String(saved));
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-busy', String(state.pending > 0));
    button.disabled = state.pending > 0;
    button.title = state.pending ? '正在同步个人数据…' : label;
  });
}
async function record(siteId: string, type: 'detail' | 'external') {
  try { await personalStore.recordVisit(siteId, type); }
  catch (cause) { if (!(cause instanceof LoginRequiredError)) personalError(cause); }
}

let observer: MutationObserver | undefined;
let starFrame = 0;
function initPersonal() {
  observer?.disconnect();
  cancelAnimationFrame(starFrame);
  syncStars();
  void personalStore.ensure().catch(personalError);
  const detail = document.querySelector<HTMLElement>('[data-detail-visit]');
  if (detail && detail.dataset.visitRecorded !== 'true') {
    detail.dataset.visitRecorded = 'true';
    void record(detail.dataset.siteId!, 'detail');
  }
  observer = new MutationObserver((records) => {
    if (!records.some((item) => [...item.addedNodes].some((node) => node instanceof Element
      && (node.matches('[data-favorite-id]') || node.querySelector('[data-favorite-id]'))))) return;
    cancelAnimationFrame(starFrame);
    starFrame = requestAnimationFrame(() => syncStars());
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

document.addEventListener('click', async (event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-favorite-id]');
  if (!button || button.disabled) return;
  event.preventDefault();
  event.stopPropagation();
  try {
    await personalStore.toggleFavorite(button.dataset.favoriteId!);
    const saved = personalStore.read('favorites').some((item) => item.siteId === button.dataset.favoriteId);
    notifyPersonal(saved ? '已加入收藏' : '已取消收藏');
  } catch (cause) { personalError(cause, 'favorite'); }
});

function onExternal(event: MouseEvent) {
  if (event.defaultPrevented || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download')) return;
  let url: URL;
  try { url = new URL(link.href); } catch { return; }
  if (!['http:', 'https:'].includes(url.protocol) || url.origin === location.origin) return;
  const siteId = link.closest<HTMLElement>('[data-site-id]')?.dataset.siteId;
  if (!siteId && !link.classList.contains('cyber-search-history__tag')) return;
  // 同页离站等待初始化/迁移/串行写入，避免 keepalive 尚未发起就销毁文档。
  const sameTab = event.type === 'click' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
    && (!link.target || link.target === '_self');
  if (sameTab) event.preventDefault();
  const visit = siteId ? record(siteId, 'external') : loadPersonalSites().then(async (catalog) => {
    const site = [...catalog.values()].find((entry) => new URL(entry.url).href === url.href);
    if (site) await record(site.id, 'external');
  }).catch(personalError);
  if (sameTab) void visit.finally(() => location.assign(url.href));
}
let pendingPersonalPath: string | undefined;
// 只门控个人列表，不触碰提交站点、账号页或其他导航。
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
  if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || !/^\/(favorites|history)\/?$/.test(url.pathname)) return;
  const state = personalStore.snapshot();
  if (state.status === 'ready') return;
  event.preventDefault();
  const path = url.pathname + url.search + url.hash;
  pendingPersonalPath = path;
  if (state.status === 'signed-out' && state.pending === 0) {
    requestPersonalAuth('personal');
    return;
  }
  // 未知身份先完成GET与迁移；失败不导航、不假装已登录。
  const check = state.status === 'error' ? personalStore.refresh() : personalStore.ensure();
  void check.then(() => {
    if (pendingPersonalPath !== path) return;
    if (personalStore.snapshot().status === 'ready') {
      pendingPersonalPath = undefined;
      location.assign(path);
    } else if (personalStore.snapshot().status === 'signed-out') requestPersonalAuth('personal');
  }).catch(personalError);
}, true);
document.addEventListener('click', onExternal, true);
document.addEventListener('auxclick', onExternal, true);
let lastMigrationWarning = '';
document.addEventListener(PERSONAL_CHANGED, () => {
  syncStars();
  const warning = personalStore.snapshot().warning;
  if (warning && warning !== lastMigrationWarning) notifyPersonal(warning);
  lastMigrationWarning = warning;
});
let refreshing = false;
function refreshPersonal() {
  if (refreshing) return;
  refreshing = true;
  void personalStore.refresh().catch(personalError).finally(() => { refreshing = false; });
}
if (channel) channel.onmessage = (event) => { if (event.data === 'changed') refreshPersonal(); };
// 账号事件不能被在途的旧会话刷新去重掉：始终排队一次新读取。
document.addEventListener('nav:account-changed', () => {
  void personalStore.refresh().then(() => {
    if (personalStore.snapshot().status !== 'ready' || !pendingPersonalPath) return;
    const path = pendingPersonalPath;
    pendingPersonalPath = undefined;
    location.assign(path);
  }).catch(personalError);
});
window.addEventListener('focus', refreshPersonal);
window.addEventListener('pageshow', (event) => { if (event.persisted) refreshPersonal(); });
document.addEventListener('astro:page-load', refreshPersonal);
document.addEventListener('astro:page-load', initPersonal);
document.addEventListener('astro:before-swap', () => {
  pendingPersonalPath = undefined;
  observer?.disconnect();
  cancelAnimationFrame(starFrame);
});
initPersonal();
