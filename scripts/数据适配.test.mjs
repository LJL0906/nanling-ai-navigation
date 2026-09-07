import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { adaptNavigation } from '../src/lib/adapt-navigation.ts';
import { isBrandIcon } from '../src/lib/brand-icon.ts';
import { isLocalSiteIcon } from '../src/lib/site-icon.ts';

const raw = JSON.parse(readFileSync(new URL('../src/data/导航数据.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(readFileSync(new URL('../src/data/sites.json', import.meta.url), 'utf8'));
const result = adaptNavigation(raw, legacy);
const allSites = result.categories.flatMap((category) => category.sites);

test('18个分类及2400个站点全量接入，未验证记录不丢失', () => {
  assert.equal(result.categories.length, 18);
  assert.equal(result.siteCount, 2400);
  assert.equal(allSites.length, raw.sites.length);
  assert.equal(new Set(allSites.map((site) => site.id)).size, raw.sites.length);
  assert.equal(allSites.filter((site) => site.verification.status === 'unverified').length, 2400);
  for (const category of result.categories) {
    const source = raw.categories.find((item) => item.id === category.id);
    assert.equal(category.sites.length, source.count);
    assert.ok(category.sites.every((site) => site.categorySlug === category.slug));
  }
});

test('分类ID正确映射到路由slug，不占用站内搜索路径', () => {
  assert.equal(result.categories.find((category) => category.id === 'search').slug, 'search-engines');
  assert.equal(result.categories.find((category) => category.id === 'news').slug, 'community');
  assert.equal(result.categories.find((category) => category.id === 'game').slug, 'games');
  assert.ok(!result.categories.some((category) => category.slug === 'search'));
});

test('首页保留5个分区和28张精选卡片，不截断分类全集', () => {
  const originals = legacy.categories.filter((category) => category.home.show);
  assert.deepEqual(result.homeCategories.map((category) => category.slug), originals.map((category) => category.slug));
  assert.equal(result.homeCategories.reduce((sum, category) => sum + category.sites.length, 0), 28);
  for (const category of result.homeCategories) {
    assert.equal(category.sites.length, category.home.limit);
    assert.ok(category.sites.every((site) => site.categorySlug === category.slug));
  }
  assert.equal(result.categories.find((category) => category.slug === 'ai').sites.length, 1403);
  assert.deepEqual(result.homeCategories.find((category) => category.slug === 'ai').sites.map((site) => site.slug),
    legacy.categories.find((category) => category.slug === 'ai').sites.map((site) => site.slug));
});

test('70条旧精选路径均可直达或跳转到新详情页，合并条目不产生重复页面', () => {
  const paths = new Set(result.categories.flatMap((category) => category.sites.map((site) => `/${category.slug}/${site.slug}/`)));
  const redirects = new Map(result.siteRedirects.map(({ from, to }) => [from, to]));
  for (const category of legacy.categories) {
    for (const site of category.sites) {
      const path = `/${category.slug}/${site.slug}/`;
      assert.ok(paths.has(path) || paths.has(redirects.get(path)), `旧路径丢失：${path}`);
    }
  }
  for (const { from, to } of result.siteRedirects) {
    assert.ok(!paths.has(from));
    assert.ok(paths.has(to));
  }
  assert.equal(redirects.get('/learn/bilibili/'), '/media/bilibili-com/');
  assert.equal(redirects.get('/entertainment/bilibili-fun/'), '/media/bilibili-com/');
});

test('搜索字段、原始图标、来源和验证状态完整保留', () => {
  const byId = new Map(allSites.map((site) => [site.id, site]));
  for (const entry of raw.sites) {
    const site = byId.get(entry.id);
    for (const field of ['aliases', 'alternateUrls', 'domain', 'tags', 'sourceCategories', 'sources', 'verification']) {
      assert.deepEqual(site[field], entry[field]);
    }
    assert.deepEqual(site.sourceIcon, entry.icon);
    assert.equal(site.url, entry.url);
    assert.ok(site.desc.trim());
    if (entry.icon?.type === 'iconify') assert.equal(site.icon, entry.icon.value);
    if (site.icon) assert.ok(isBrandIcon(site.icon) || isLocalSiteIcon(site.icon));
  }
});

test('未知分类直接报错，不静默丢弃站点', () => {
  const invalid = structuredClone(raw);
  invalid.sites[0].category = 'missing-category';
  assert.throws(() => adaptNavigation(invalid, legacy), /不存在的分类/);
});

test('缺失描述提供兜底文案，不改写网址', () => {
  const input = structuredClone(raw);
  input.sites[0].description = '  ';
  const output = adaptNavigation(input, legacy).categories.flatMap((category) => category.sites);
  const site = output.find((entry) => entry.id === input.sites[0].id);
  assert.ok(site.desc.includes(site.name));
  assert.equal(site.url, input.sites[0].url);
});

const localPath = `/site-icons/${'a'.repeat(64)}.png`;
function adaptedSite(icon, manifest = {}, sources = []) {
  const entry = { ...raw.sites[0], icon, sources };
  return adaptNavigation({ ...raw, sites: [entry] }, legacy, manifest).categories
    .flatMap((category) => category.sites)[0];
}

test('默认读取本地manifest；显式空manifest不加载原始URL或raw图标', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/data/站点图标.json', import.meta.url), 'utf8'));
  for (const site of allSites.filter((site) => !isBrandIcon(site.icon))) {
    assert.equal(site.icon, isLocalSiteIcon(manifest[site.id]) ? manifest[site.id] : null);
  }
  for (const icon of [null, { type: 'url', value: 'https://example.com/icon.png' },
    { type: 'raw', value: '<img src=x onerror=alert(1)>' }, { type: 'url', value: localPath }]) {
    assert.equal(adaptedSite(icon).icon, null);
    const mapped = adaptedSite(icon, { [raw.sites[0].id]: localPath });
    assert.equal(mapped.icon, localPath);
    assert.deepEqual(mapped.sourceIcon, icon);
  }
});

test('本地映射只接受64位小写hex文件名和五种图片扩展名', () => {
  for (const extension of ['png', 'ico', 'jpg', 'gif', 'webp']) {
    const path = `/site-icons/${'0123456789abcdef'.repeat(4)}.${extension}`;
    assert.equal(adaptedSite(null, { [raw.sites[0].id]: path }).icon, path);
  }
  const invalid = [null, 42, {}, [], true, '', `https://example.com${localPath}`, `//example.com${localPath}`,
    `data:image/png;base64,AAAA`, 'javascript:alert(1)', localPath.replace('/site-icons/', '/other/'),
    localPath.replace('a'.repeat(64), 'a'.repeat(63)), localPath.replace('a'.repeat(64), 'a'.repeat(65)),
    localPath.replace('a', 'A'), localPath.replace('.png', '.svg'), localPath.replace('.png', '.PNG'),
    localPath.replace('.png', '.jpeg'), `${localPath}?x=1`, `${localPath}#x`, `${localPath}\n`,
    `${localPath}\r`, ` ${localPath}`, `${localPath} `, `${localPath}\0`,
    localPath.replace('/site-icons/', '/site-icons/../'), localPath.replace('/site-icons/', '/site-icons/%2e%2e/'),
    localPath.replace('/site-icons/', '/site-icons\\'), localPath.replace('a', '%61'),
    `<img src="${localPath}">`];
  for (const path of invalid) {
    assert.equal(adaptedSite(null, { [raw.sites[0].id]: path }).icon, null, String(path));
  }
  assert.equal(adaptedSite(null, Object.create({ [raw.sites[0].id]: localPath })).icon, null);
});

test('有效Iconify和旧品牌图标优先于manifest；无效图标回退', () => {
  const manifest = { [raw.sites[0].id]: localPath };
  assert.equal(adaptedSite({ type: 'iconify', value: 'simple-icons:github' }, manifest).icon, 'simple-icons:github');
  assert.equal(adaptedSite({ type: 'iconify', value: 'lucide:globe' }, manifest).icon, 'lucide:globe');
  for (const value of ['simple-icons:not-a-real-brand-xyz', 'unknown:github', 'https://example.com/icon.svg', localPath]) {
    assert.equal(adaptedSite({ type: 'iconify', value }, manifest).icon, localPath);
  }
  const category = legacy.categories.find((category) => category.sites.some((site) => isBrandIcon(site.icon)));
  const original = category.sites.find((site) => isBrandIcon(site.icon));
  const sources = [{ dataset: 'sites.json', recordId: `${category.slug}/${original.slug}` }];
  for (const icon of [null, { type: 'url', value: 'https://example.com/icon.png' },
    { type: 'iconify', value: 'simple-icons:not-a-real-brand-xyz' }]) {
    assert.equal(adaptedSite(icon, manifest, sources).icon, original.icon);
  }
});

test('适配不改写原始导航数据、legacy或manifest', () => {
  const input = structuredClone(raw);
  const old = structuredClone(legacy);
  const manifest = Object.freeze({ [raw.sites[0].id]: localPath });
  adaptNavigation(input, old, manifest);
  assert.deepEqual(input, raw);
  assert.deepEqual(old, legacy);
  assert.deepEqual(manifest, { [raw.sites[0].id]: localPath });
});

test('MySQL 管理模式使用数据库卡片顺序及分类颜色图标，不被旧精选覆盖', () => {
  const managed = structuredClone(raw);
  managed.sites.reverse();
  const category = managed.categories.find(item => legacy.categories.some(old => old.slug === item.slug));
  category.color = '#112233';
  category.icon = 'lucide:folder';
  const actual = adaptNavigation(managed, legacy, {}, { managed: true });
  const selected = actual.categories.find(item => item.id === category.id);
  assert.equal(selected.color, '#112233');
  assert.equal(selected.icon, 'lucide:folder');
  assert.deepEqual(selected.sites.map(item => item.id), managed.sites.filter(item => item.category === category.id).map(item => item.id));
});
