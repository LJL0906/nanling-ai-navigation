import { appendSiteImage } from './site-icons.ts';
import { PERSONAL_CHANGED, personalStore, notifyPersonal, personalError } from './personal';
import { requestPersonalAuth } from './personal-api';
import { loadPersonalSites } from './personal-catalog';
import type { PersonalSite } from './personal-catalog';
import type { PersonalKind } from '../lib/personal-store';

let dispose: (() => void) | undefined;
function initPersonalPage() {
  dispose?.();
  const root = document.querySelector<HTMLElement>('[data-personal-page]');
  if (!root) return;
  const kind = root.dataset.personalPage as PersonalKind;
  const filter = root.querySelector<HTMLInputElement>('[data-personal-filter]')!;
  const list = root.querySelector<HTMLElement>('[data-personal-list]')!;
  const status = root.querySelector<HTMLElement>('[data-personal-status]')!;
  const empty = root.querySelector<HTMLElement>('[data-personal-empty]')!;
  const noResults = root.querySelector<HTMLElement>('[data-personal-no-results]')!;
  const error = root.querySelector<HTMLElement>('[data-personal-error]')!;
  const login = root.querySelector<HTMLElement>('[data-personal-login]')!;
  const errorMessage = error.querySelector<HTMLElement>('[data-personal-error-message]')!;
  const retry = root.querySelector<HTMLButtonElement>('[data-personal-retry]')!;
  const clear = root.querySelector<HTMLButtonElement>('[data-personal-clear]')!;
  const more = root.querySelector<HTMLButtonElement>('[data-personal-more]')!;
  const template = root.querySelector<HTMLTemplateElement>('[data-personal-card]')!;
  const controller = new AbortController();
  const options = { signal: controller.signal };
  let catalog: Map<string, PersonalSite> | undefined;
  let limit = 48;
  let sequence = 0;
  let catalogLoading = false;
  let catalogError = '';
  let authPrompted = false;

  function render() {
    if (!root?.isConnected) return;
    const state = personalStore.snapshot();
    const busy = state.pending > 0 || catalogLoading;
    root.setAttribute('aria-busy', String(busy));
    login.hidden = state.status !== 'signed-out';
    errorMessage.textContent = state.error || catalogError || state.warning;
    error.hidden = !errorMessage.textContent || state.status === 'signed-out';
    retry.disabled = busy;
    clear.disabled = true;
    more.hidden = true;
    empty.hidden = true;
    noResults.hidden = true;
    if (state.status === 'signed-out') {
      list.replaceChildren();
      status.textContent = '登录后查看和管理云端收藏与访问记录。';
      if (state.pending === 0 && !authPrompted) {
        authPrompted = true;
        requestPersonalAuth('personal');
      }
      return;
    }
    if (!catalog) {
      status.textContent = busy ? '正在加载…' : '列表加载失败，请重试。';
      return;
    }
    try {
      const records = personalStore.read(kind);
      const query = filter.value.trim().toLocaleLowerCase();
      const matches = records.filter((record) => {
        const site = catalog!.get(record.siteId);
        return !query || [site?.name, site?.desc, site?.categoryName, record.siteId].join(' ').toLocaleLowerCase().includes(query);
      });
      const fragment = document.createDocumentFragment();
      matches.slice(0, limit).forEach((record) => {
        const site = catalog!.get(record.siteId);
        const item = template.content.cloneNode(true) as DocumentFragment;
        const card = item.querySelector<HTMLElement>('.nav-card')!;
        card.dataset.siteId = record.siteId;
        const detail = item.querySelector<HTMLAnchorElement>('.nav-card-detail')!;
        const external = item.querySelector<HTMLAnchorElement>('.nav-card-external')!;
        const star = item.querySelector<HTMLButtonElement>('[data-favorite-id]')!;
        star.dataset.favoriteId = record.siteId;
        star.dataset.siteName = site?.name ?? '已下架站点';
        const saved = state.data.favorites.some((item) => item.siteId === record.siteId);
        star.setAttribute('aria-pressed', String(saved));
        star.setAttribute('aria-label', `${saved ? '取消收藏' : '收藏'} ${star.dataset.siteName}`);
        star.setAttribute('aria-busy', String(busy));
        star.disabled = busy;
        detail.textContent = site?.name ?? '站点已下架';
        detail.title = site?.name ?? record.siteId;
        detail.setAttribute('aria-label', site ? `查看 ${site.name} 详情` : '站点已下架');
        if (site) {
          detail.href = `/${encodeURIComponent(site.categorySlug)}/${encodeURIComponent(site.slug)}/`;
          external.href = site.url;
          external.setAttribute('aria-label', `直达 ${site.name} 官网（新窗口打开）`);
        } else {
          detail.removeAttribute('href');
          external.removeAttribute('href');
          external.hidden = true;
        }
        item.querySelector<HTMLElement>('.nav-card-copy > p')!.textContent = site?.desc ?? '原站点已不在当前索引中，可移除此记录。';
        const icon = item.querySelector<HTMLElement>('.nav-card-icon')!;
        const color = /^#[\da-f]{6}$/i.test(site?.color ?? '') ? site!.color : '#3777f5';
        icon.style.backgroundColor = `${color}1f`;
        const glyph = icon.querySelector<HTMLElement>('span')!;
        glyph.textContent = site?.mono ?? Array.from(site?.name ?? '?')[0];
        glyph.style.color = color;
        glyph.dataset.siteIconFallback = '';
        appendSiteImage(icon, site?.icon);
        const time = item.querySelector<HTMLTimeElement>('time')!;
        time.dateTime = record.updatedAt;
        time.textContent = `${kind === 'favorites' ? '收藏于' : record.visitType === 'external' ? '打开官网' : '浏览详情'} ${new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}`;
        const remove = item.querySelector<HTMLButtonElement>('[data-personal-remove]')!;
        remove.dataset.personalRemove = record.siteId;
        remove.disabled = busy;
        remove.setAttribute('aria-busy', String(busy));
        remove.setAttribute('aria-label', `移除 ${site?.name ?? '已下架站点'} 的${kind === 'favorites' ? '收藏' : '访问记录'}`);
        fragment.append(item);
      });
      list.replaceChildren(fragment);
      empty.hidden = records.length > 0 || busy || state.status !== 'ready';
      noResults.hidden = records.length === 0 || matches.length > 0;
      clear.disabled = records.length === 0 || busy;
      more.hidden = matches.length <= limit;
      status.textContent = `共 ${records.length} 条${query ? `，匹配 ${matches.length} 条` : ''}，已显示 ${Math.min(limit, matches.length)} 条`;
      if (records.length && !matches.length) status.textContent += '，没有符合条件的记录';
      if (busy) status.textContent = '正在同步，请稍候…';
      else if (state.error || catalogError) status.textContent = '操作失败，以下仅展示最近一次服务端确认的数据。';
      else if (state.warning) status.textContent += '；旧数据迁移有告警，账号数据可正常管理。';
    } catch {
      error.hidden = false;
      errorMessage.textContent = '列表渲染失败，请重试。';
      status.textContent = '无法展示个人数据';
      clear.disabled = true;
    }
  }
  async function load(refresh = false) {
    const current = ++sequence;
    catalogLoading = true;
    catalogError = '';
    render();
    const catalogTask = loadPersonalSites().then((value) => {
      if (!controller.signal.aborted && current === sequence) catalog = value;
    }).catch(() => {
      if (!controller.signal.aborted && current === sequence) catalogError = '站点索引加载失败，请重试。';
    });
    await Promise.all([catalogTask, (refresh ? personalStore.refresh() : personalStore.ensure()).catch(() => {})]);
    if (controller.signal.aborted || current !== sequence) return;
    catalogLoading = false;
    render();
  }
  filter.addEventListener('input', () => { limit = 48; render(); }, options);
  root.querySelector('[data-personal-reset]')!.addEventListener('click', () => {
    filter.value = '';
    limit = 48;
    render();
    filter.focus();
  }, options);
  more.addEventListener('click', () => { limit += 48; render(); }, options);
  clear.addEventListener('click', async () => {
    if (!confirm(`确定清空${kind === 'favorites' ? '全部收藏' : '全部访问记录'}？此操作将删除当前账号的数据库记录，并同步到所有设备，无法撤销。`)) return;
    try { await personalStore.clear(kind); notifyPersonal('已清空'); }
    catch (cause) { personalError(cause); }
  }, options);
  list.addEventListener('click', async (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-personal-remove]');
    if (!button || button.disabled) return;
    try { await personalStore.remove(kind, button.dataset.personalRemove!); notifyPersonal('已移除'); }
    catch (cause) { personalError(cause); }
  }, options);
  login.querySelector('button')!.addEventListener('click', () => requestPersonalAuth('personal'), options);
  retry.addEventListener('click', () => { void load(true); }, options);
  document.addEventListener(PERSONAL_CHANGED, render, options);
  dispose = () => controller.abort();
  void load();
}
document.addEventListener('astro:page-load', initPersonalPage);
document.addEventListener('astro:before-swap', () => { dispose?.(); dispose = undefined; });
initPersonalPage();

