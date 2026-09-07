import { isLocalSiteIcon } from '../lib/site-icon.ts';

const bound = new WeakSet<HTMLImageElement>();

/** 首字一直保留到成功解码；坏图移除，不显示浏览器 broken-image 标记。 */
export function bindSiteImage(image: HTMLImageElement) {
  if (bound.has(image)) return;
  bound.add(image);
  const fallback = image.parentElement?.querySelector<HTMLElement>('[data-site-icon-fallback]');
  const settle = () => {
    if (image.naturalWidth > 0) {
      image.style.opacity = '1';
      if (fallback) fallback.style.visibility = 'hidden';
    } else {
      if (fallback) fallback.style.visibility = '';
      image.remove();
    }
  };
  image.addEventListener('load', settle, { once: true });
  image.addEventListener('error', () => {
    if (fallback) fallback.style.visibility = '';
    image.remove();
  }, { once: true });
  // template 克隆仍属于惰性文档时，尚未开始请求也可能 complete=true。
  // 未挂载且零宽不等于加载失败，必须等插入页面后的 load/error 再决定。
  if (image.complete && (image.naturalWidth > 0 || image.isConnected)) settle();
}

/** 动态卡片直接创建图片，不为 manifest 中的每个站点预生成模板。 */
export function appendSiteImage(container: HTMLElement, value: unknown): HTMLImageElement | undefined {
  if (!isLocalSiteIcon(value)) return;
  const image = document.createElement('img');
  image.alt = '';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.dataset.siteIconImage = '';
  image.style.cssText = 'position:absolute;width:72%;height:72%;object-fit:contain;opacity:0';
  container.style.position = 'relative';
  container.append(image);
  // 先设 src，再检查 complete；空 src 的新图片可能已被浏览器标为 complete。
  image.src = value;
  bindSiteImage(image);
  return image;
}

export function initSiteImages() {
  document.querySelectorAll<HTMLImageElement>('img[data-site-icon-image]').forEach(bindSiteImage);
}
