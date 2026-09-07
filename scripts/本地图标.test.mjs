import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendSiteImage, bindSiteImage, initSiteImages } from '../src/scripts/site-icons.ts';
import { isLocalSiteIcon } from '../src/lib/site-icon.ts';

const path = `/site-icons/${'a'.repeat(64)}.png`;
class FakeImage extends EventTarget {
  style = {};
  dataset = {};
  complete = false;
  isConnected = true;
  naturalWidth = 0;
  removed = false;
  subscriptions = 0;
  addEventListener(...args) { this.subscriptions++; super.addEventListener(...args); }
  remove() { this.removed = true; }
}
function container() {
  return {
    style: {}, children: [], fallback: { style: {} },
    querySelector(selector) { assert.equal(selector, '[data-site-icon-fallback]'); return this.fallback; },
    append(image) { image.parentElement = this; this.children.push(image); },
  };
}
// 原生 EventTarget 驱动实际 load/error 回调，不依赖网络或第三方 DOM 测试依赖。
function mockDocument(t, image = new FakeImage()) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let created = 0;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement(tag) { assert.equal(tag, 'img'); created++; return image; },
    querySelectorAll(selector) { assert.equal(selector, 'img[data-site-icon-image]'); return [image]; },
  } });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else delete globalThis.document;
  });
  return { image, created: () => created };
}

test('动态图片只接受本地白名单，不创建外站/raw/畸形路径图片', (t) => {
  const dom = mockDocument(t);
  const target = container();
  for (const value of [null, {}, 'simple-icons:github', 'https://example.com/a.png', '//evil/a.png',
    '<img onerror=alert(1)>', `${path}?x`, `${path}\n`, path.replace('.png', '.svg')]) {
    assert.equal(isLocalSiteIcon(value), false);
    assert.equal(appendSiteImage(target, value), undefined);
  }
  assert.equal(dom.created(), 0);
});

test('动态图片惰性加载、无inline事件，成功前保留首字，成功后才显示图片', (t) => {
  const dom = mockDocument(t);
  const target = container();
  const image = appendSiteImage(target, path);
  assert.equal(image.src, path);
  assert.equal(image.alt, '');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.decoding, 'async');
  assert.equal(image.referrerPolicy, 'no-referrer');
  assert.equal(image.onerror, undefined);
  assert.match(image.style.cssText, /opacity:0/);
  assert.notEqual(target.fallback.style.visibility, 'hidden');
  image.naturalWidth = 32;
  image.dispatchEvent(new Event('load'));
  assert.equal(image.style.opacity, '1');
  assert.equal(target.fallback.style.visibility, 'hidden');
  assert.equal(image.removed, false);
  assert.equal(dom.created(), 1);
});

test('加载失败或零宽坏图移除图片，保持首字且不会暴露broken-image', (t) => {
  const dom = mockDocument(t);
  const target = container();
  const image = appendSiteImage(target, path);
  image.dispatchEvent(new Event('error'));
  assert.equal(image.removed, true);
  assert.equal(target.fallback.style.visibility, '');
  const invalid = new FakeImage();
  target.append(invalid);
  bindSiteImage(invalid);
  invalid.dispatchEvent(new Event('load'));
  assert.equal(invalid.removed, true);
  assert.equal(dom.created(), 1);
});

test('SSR已缓存成功/失败图片立即恢复正确状态；页面重入不重复绑定', (t) => {
  const image = new FakeImage();
  image.complete = true;
  image.naturalWidth = 48;
  const target = container();
  target.append(image);
  mockDocument(t, image);
  initSiteImages();
  initSiteImages();
  assert.equal(image.subscriptions, 2);
  assert.equal(image.style.opacity, '1');
  assert.equal(target.fallback.style.visibility, 'hidden');
  const failed = new FakeImage();
  failed.complete = true;
  target.append(failed);
  bindSiteImage(failed);
  assert.equal(failed.removed, true);
  assert.equal(target.fallback.style.visibility, '');
});

test('首页仅为有效品牌图标建模板，首页/搜索/个人列表共用本地图像逻辑', () => {
  const source = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const home = source('src/components/home/HomeNavigation.astro');
  assert.match(home, /\.filter\(isBrandIcon\)/);
  for (const file of ['homeNavigation', 'search', 'personal-page']) {
    assert.match(source(`src/scripts/${file}.ts`), /appendSiteImage\(icon, /);
  }
  const brand = source('src/components/ui/BrandIcon.astro');
  assert.match(brand, /isBrandIcon\(icon\)/);
  assert.match(brand, /isLocalSiteIcon\(icon\)/);
  assert.match(brand, /data-site-icon-fallback/);
  assert.match(brand, /opacity:0/);
  assert.match(brand, /astro:page-load/);
  assert.doesNotMatch(brand, /\bon(?:error|load)=/i);
  assert.match(source('src/pages/search-index.json.ts'), /icon: site\.icon/);
  assert.match(source('src/pages/personal-sites.json.ts'), /mono, icon, categorySlug/);
});


test('实际图标映射仅引用现有站点，全部图片存在且内容哈希与文件名一致', () => {
  const readJSON = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  const manifest = readJSON('src/data/站点图标.json');
  const ids = new Set(readJSON('src/data/导航数据.json').sites.map((site) => site.id));
  for (const [id, value] of Object.entries(manifest)) {
    assert.ok(ids.has(id), `图标映射引用不存在的站点：${id}`);
    assert.ok(isLocalSiteIcon(value), `图标路径不合法：${id}`);
    const body = readFileSync(new URL(`../public${value}`, import.meta.url));
    assert.ok(body.length > 0 && body.length <= 2 * 1024 * 1024, `图标大小异常：${id}`);
    assert.equal(createHash('sha256').update(body).digest('hex'), value.split('/').at(-1).split('.')[0],
      `图标内容与文件名哈希不一致：${id}`);
  }
});


test('template离线克隆complete为true且零宽不提前删除，挂载后仍能显示图片', (t) => {
  const image = new FakeImage();
  image.complete = true;
  image.isConnected = false;
  mockDocument(t, image);
  const target = container();
  appendSiteImage(target, path);
  assert.equal(image.removed, false, '未请求的模板图像不应误判为坏图');
  assert.notEqual(target.fallback.style.visibility, 'hidden');
  image.isConnected = true;
  image.naturalWidth = 32;
  image.dispatchEvent(new Event('load'));
  assert.equal(image.style.opacity, '1');
  assert.equal(target.fallback.style.visibility, 'hidden');
});

test('template离线图像挂载后的真实error仍移除坏图并保留首字', (t) => {
  const image = new FakeImage();
  image.complete = true;
  image.isConnected = false;
  mockDocument(t, image);
  const target = container();
  appendSiteImage(target, path);
  assert.equal(image.removed, false);
  image.isConnected = true;
  image.dispatchEvent(new Event('error'));
  assert.equal(image.removed, true);
  assert.equal(target.fallback.style.visibility, '');
});
