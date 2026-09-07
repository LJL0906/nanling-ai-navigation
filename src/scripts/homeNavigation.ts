import { initHomeTabs } from './homeTabs';
import { getHomeSectionSizes, type HomeSectionData, type HomeSite } from '../lib/home-sections';
import { normalizeMenuOrder, readMenuOrder } from '../lib/menu-order.ts';
import { appendSiteImage } from './site-icons.ts';

let disposeHome: (() => void) | undefined;
function initHomeNavigation() {
  disposeHome?.();
  disposeHome = undefined;
  const root = document.querySelector<HTMLElement>('[data-home-navigation]');
  if (!root) return;
  const { pageSize, moreSize } = getHomeSectionSizes(Number(root.dataset.homePageSize));
  const sections: HomeSectionData[] = JSON.parse(root.querySelector('[data-home-data]')?.textContent ?? '[]');
  const controller = new AbortController();
  const options = { signal: controller.signal };
  const template = root.querySelector<HTMLTemplateElement>('[data-home-card]')!;
  const icons = new Map(Array.from(root.querySelectorAll<HTMLTemplateElement>('[data-home-icon]'))
    .map((icon) => [icon.dataset.homeIcon!, icon]));

  function createCard(site: HomeSite) {
    const card = template.content.cloneNode(true) as DocumentFragment;
    card.querySelector<HTMLElement>('[data-site-id]')!.dataset.siteId = site.id;
    const favorite = card.querySelector<HTMLButtonElement>('[data-favorite-id]')!;
    favorite.dataset.favoriteId = site.id;
    favorite.dataset.siteName = site.name;
    const primary = card.querySelector<HTMLAnchorElement>('.nav-card-detail')!;
    primary.href = site.url;
    primary.textContent = site.name;
    primary.title = site.name;
    primary.setAttribute('aria-label', `直达 ${site.name} 官网（新窗口打开）`);
    const external = card.querySelector<HTMLAnchorElement>('.nav-card-external')!;
    external.href = site.url;
    external.setAttribute('aria-label', `直达 ${site.name} 官网（新窗口打开）`);
    const desc = card.querySelector<HTMLElement>('.nav-card-copy > p')!;
    desc.textContent = site.desc;
    desc.title = site.desc;
    const color = /^#[\da-f]{6}$/i.test(site.color) ? site.color : '#3777f5';
    let icon = card.querySelector<HTMLElement>('.nav-card-icon')!;
    const iconTemplate = site.icon ? icons.get(site.icon) : undefined;
    if (iconTemplate) {
      const replacement = iconTemplate.content.firstElementChild!.cloneNode(true) as HTMLElement;
      icon.replaceWith(replacement);
      icon = replacement;
      const svg = icon.querySelector('svg');
      if (svg) svg.style.color = color;
    } else {
      const glyph = icon.querySelector<HTMLElement>('span')!;
      glyph.textContent = site.mono ?? Array.from(site.name)[0] ?? '?';
      glyph.style.color = color;
      appendSiteImage(icon, site.icon);
    }
    icon.style.backgroundColor = `${color}1f`;
    return card;
  }

  const tabCleanups: (() => void)[] = [];
  for (const section of sections) {
    const element = root.querySelector<HTMLElement>(`[data-home-section="${section.slug}"]`)!;
    tabCleanups.push(initHomeTabs(element, controller.signal));
    const list = element.querySelector<HTMLUListElement>('[data-home-sites]')!;
    const panel = element.querySelector<HTMLElement>('[data-home-panel]')!;
    const status = element.querySelector<HTMLElement>('[data-home-status]')!;
    const tabs = Array.from(element.querySelectorAll<HTMLButtonElement>('[data-home-tab]'));
    const more = element.querySelector<HTMLButtonElement>('[data-home-more]')!;
    // 页面回访时读取 DOM 状态，不重置其他分区已选的 Tab。
    let selected = section.tabs.find((tab) => tab.key === element.dataset.selectedTab) ?? section.tabs[0];
    // 初始化和 Astro 回访只读取已展示数量，不自动补齐或重建 SSR 卡片。
    let visible = list.children.length;
    const syncStatus = () => {
      const remaining = selected.indices.length - visible;
      status.textContent = `${selected.label}：共 ${selected.indices.length} 个，${remaining > 0 ? `已显示 ${visible} 个` : '已全部显示'}`;
      more.hidden = remaining <= 0;
      more.textContent = `加载更多（${Math.min(moreSize, remaining)} 个）`;
    };
    function renderSites(append = false) {
      const start = append ? visible : 0;
      const end = Math.min(start + (append ? moreSize : pageSize), selected.indices.length);
      const fragment = document.createDocumentFragment();
      selected.indices.slice(start, end).forEach((index) => fragment.append(createCard(section.sites[index])));
      if (append) list.append(fragment);
      else list.replaceChildren(fragment);
      visible = end;
      syncStatus();
      scheduleActive();
    }
    more.addEventListener('click', () => {
      if (visible < selected.indices.length) renderSites(true);
    }, options);
    function selectTab(button: HTMLButtonElement) {
      const next = section.tabs.find((tab) => tab.key === button.dataset.homeTab);
      if (!next || next.key === selected.key) return;
      selected = next;
      element.dataset.selectedTab = selected.key;
      tabs.forEach((tab) => {
        tab.setAttribute('aria-selected', String(tab === button));
        tab.tabIndex = tab === button ? 0 : -1;
      });
      panel.setAttribute('aria-labelledby', button.id);
      list.setAttribute('aria-label', `${section.name} · ${selected.label}站点列表`);
      renderSites();
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => selectTab(tab), options);
      tab.addEventListener('keydown', (event) => {
        let next = index;
        if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
        else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = tabs.length - 1;
        else return;
        event.preventDefault();
        tabs[next].focus();
        selectTab(tabs[next]);
      }, options);
    });
    syncStatus();
  }

  const elements = Array.from(root.querySelectorAll<HTMLElement>('[data-home-section]'));
  const sectionByHref = new Map(elements.map((element) => [`/${element.dataset.homeSection}/`, element]));
  // JSON 保留服务端默认顺序，不能把回访时已排序的 DOM 当作默认值。
  const defaultIds = sections.map((section) => `/${section.slug}/`).filter((href) => sectionByHref.has(href));
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('[data-home-anchor]'));
  const home = document.querySelector<HTMLAnchorElement>('[data-home-start]');
  let frame = 0;
  const updateActive = () => {
    frame = 0;
    let active = '';
    let closestTop = -Infinity;
    let lastTop = -Infinity;
    let lastId = '';
    for (const element of elements) {
      const top = element.getBoundingClientRect().top;
      if (top > lastTop) {
        lastTop = top;
        lastId = element.id;
      }
      if (top <= 140 && top > closestTop) {
        closestTop = top;
        active = element.id;
      }
    }
    // 最后一个分区较矮时无法到达激活线；触底后按实际布局选中末尾分区。
    const scroller = document.scrollingElement;
    if (scroller && scroller.scrollTop > 0
      && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
      active = lastId;
    }
    anchors.forEach((anchor) => {
      const selected = anchor.dataset.homeAnchor === active;
      anchor.dataset.homeActive = String(selected);
      if (selected) anchor.setAttribute('aria-current', 'location');
      else anchor.removeAttribute('aria-current');
    });
    if (home) {
      home.dataset.homeActive = String(!active);
      if (!active) home.setAttribute('aria-current', 'page');
      else home.removeAttribute('aria-current');
    }
  };
  const applyOrder = (ids: unknown) => {
    const ordered = normalizeMenuOrder(defaultIds, ids).map((href) => sectionByHref.get(href)!);
    const current = Array.from(root.querySelectorAll<HTMLElement>('[data-home-section]'));
    if (ordered.some((element, index) => element !== current[index])) {
      // 只替换分区所在槽位，hero、模板和 JSON 等其他节点保持原位。
      const slots = current.map((element) => {
        const slot = document.createComment('home-section');
        element.replaceWith(slot);
        return slot;
      });
      slots.forEach((slot, index) => slot.replaceWith(ordered[index]));
    }
    cancelAnimationFrame(frame);
    updateActive();
  };
  document.addEventListener('nav:menu-order-change', (event) => {
    applyOrder((event as CustomEvent<unknown>).detail);
  }, options);
  const scheduleActive = () => { if (!frame) frame = requestAnimationFrame(updateActive); };
  window.addEventListener('scroll', scheduleActive, { ...options, passive: true });
  window.addEventListener('resize', scheduleActive, options);
  window.addEventListener('hashchange', scheduleActive, options);
  window.addEventListener('popstate', scheduleActive, options);
  anchors.forEach((anchor) => anchor.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const target = elements.find((element) => element.id === anchor.dataset.homeAnchor);
    if (!target) return;
    event.preventDefault();
    const hash = `#${target.id}`;
    if (location.hash !== hash) history.pushState(history.state, '', hash);
    document.documentElement.classList.remove('drawer-open');
    document.querySelectorAll('[data-drawer-open]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    target.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
    scheduleActive();
  }, options));
  home?.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    // 当前 URL 已是 / 时 ClientRouter 不会重新导航，因此显式处理回顶。
    const url = new URL(location.href);
    url.hash = '';
    if (url.href !== location.href) history.pushState(history.state, '', url);
    document.documentElement.classList.remove('drawer-open');
    document.querySelectorAll('[data-drawer-open]').forEach((button) => button.setAttribute('aria-expanded', 'false'));
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    updateActive();
  }, options);
  // 延迟访问 localStorage，让 readMenuOrder 同时兜底存储被禁用的情况。
  applyOrder(readMenuOrder({ getItem: (key) => localStorage.getItem(key) }, defaultIds));
  disposeHome = () => { controller.abort(); tabCleanups.forEach((cleanup) => cleanup()); cancelAnimationFrame(frame); };
}

document.addEventListener('astro:page-load', initHomeNavigation);
document.addEventListener('astro:before-swap', () => { disposeHome?.(); disposeHome = undefined; });
initHomeNavigation();

