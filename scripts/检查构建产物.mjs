import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { parse } from '@astrojs/compiler';
import { buildMenuSeed } from '../src/server/menu-seed.ts';
import { visibleMenus } from '../src/server/menu-validation.ts';
import { curatedGroupsFromMenus } from '../src/lib/curated-menu-directory.ts';
const RESOURCE_GROUPS = curatedGroupsFromMenus(visibleMenus(buildMenuSeed().menus));
import { HOME_SECTION_PAGE_SIZE } from '../src/lib/home-sections.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const buildDir = process.env.NAV_BUILD_DIR ?? 'dist';
const entry = join(root, buildDir, 'server/entry.mjs');
assert.ok(existsSync(entry), '缺少Node产物，请先执行 npm run build');
assert.ok(existsSync(join(root, buildDir, 'client')), '缺少客户端资源');
const raw = JSON.parse(readFileSync(join(root, 'src/data/导航数据.json'), 'utf8'));
const categoryById = new Map(raw.categories.map((category) => [category.id, category]));
const siteById = new Map(raw.sites.map((site) => [site.id, site]));
const attr = (node, name) => node.attributes?.find((attribute) => attribute.name === name)?.value;
const hasClass = (node, name) => (attr(node, 'class') ?? '').split(/\s+/).includes(name);
function descendants(node, predicate) {
  return (node.children ?? []).flatMap((child) => [
    ...(predicate(child) ? [child] : []), ...descendants(child, predicate),
  ]);
}
function assertOfficialLink(link, site, label) {
  assert.equal(link.name, 'a', label);
  assert.equal(attr(link, 'href'), site.url, label + '：主体必须直达对应官网');
  assert.equal(attr(link, 'target'), '_blank', label + '：必须新窗口打开');
  const rel = new Set((attr(link, 'rel') ?? '').split(/\s+/));
  for (const value of ['noopener', 'noreferrer']) assert.ok(rel.has(value), label + '：缺少 ' + value);
}
async function checkCards(html, label) {
  // 校验所有分类的首批卡片，阻止首页回退到一次渲染全部站点。
  if (label === '首页') {
    const sections = [...html.matchAll(/<section\b[^>]*data-home-section[^>]*>[\s\S]*?<\/section>/g)];
    assert.equal(sections.length, raw.categories.length, '首页必须展示全部分类');
    let count = 0;
    for (const [index, section] of sections.entries()) {
      count += (await checkCards(section[0], `首页分区 ${index + 1}`)).count;
    }
    const expected = raw.categories.reduce((sum, category) => sum + Math.min(HOME_SECTION_PAGE_SIZE, raw.sites.filter(site => site.category === category.id).length), 0);
    assert.equal(count, expected, '首页每个分区仅渲染首批卡片');
    assert.ok(count < raw.sites.length, '首页不能恢复全量渲染');
    assert.ok(html.includes('data-home-more'), '完整列表支持按需加载');
    assert.ok(Buffer.byteLength(html) < 2_000_000, '首页HTML须控制在2MB内');
    return { count };
  }
  // 解析实际响应的 HTML 树，而不是匹配源码；同时覆盖首页用于动态克隆的 template。
  const { ast } = await parse(html);
  const cards = descendants(ast, (node) => hasClass(node, 'nav-card'));
  assert.ok(cards.length > 0, label + '：未找到 SiteCard，不能空集通过');
  for (const card of cards) {
    const site = siteById.get(attr(card, 'data-site-id'));
    assert.ok(site, label + '：卡片应关联真实站点');
    const links = descendants(card, (node) => hasClass(node, 'nav-card-detail'));
    assert.equal(links.length, 1, label + '：保留唯一主体 selector');
    assertOfficialLink(links[0], site, label + ' / ' + site.name);
    assert.ok(attr(links[0], 'aria-label')?.includes('官网'), label + '：主体标签应提示直达官网');
    const external = descendants(card, (node) => hasClass(node, 'nav-card-external'));
    assert.equal(external.length, 1, label + '：保留独立官网入口');
    assertOfficialLink(external[0], site, label + ' / 独立官网入口');
    const favorites = descendants(card, (node) => attr(node, 'data-favorite-id') !== undefined);
    assert.equal(favorites.length, 1, label + '：保留收藏按钮');
    assert.equal(favorites[0].name, 'button');
    assert.equal(attr(favorites[0], 'data-favorite-id'), site.id);
    // 从整棵树检查祖先，既阻止主体链接包裹收藏，也阻止外层卡片变成链接。
    for (const anchor of descendants(ast, (node) => node.name === 'a')) {
      assert.ok(!descendants(anchor, (node) => node === favorites[0]).length,
        label + ' / ' + site.name + '：收藏必须在所有链接之外');
    }
  }
  return { ast, count: cards.length };
}
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const token = randomBytes(32).toString('hex');
const base = `http://127.0.0.1:${port}`;
let output = '';
const server = spawn(process.execPath, [entry], {
  cwd: root, windowsHide: true,
  env: { ...process.env, NAV_STORAGE: 'seed', HOST: '127.0.0.1', PORT: String(port), ADMIN_TOKEN: token },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
server.stderr.on('data', (chunk) => { output = (output + chunk).slice(-12000); });
const request = (path, options = {}) => fetch(base + path, { signal: AbortSignal.timeout(15000), ...options });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Node服务启动失败：${output}`);
    try { ready = (await request('/api/health')).status === 200; } catch {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, `Node服务未就绪：${output}`);
  let homeCards = 0;
  for (const path of ['/', '/categories/', '/tags/', '/search/', '/search/?q=', '/search/?q=AI', '/admin/', '/admin/menus/', '/ai/', '/ai/page/2/']) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.ok(!html.includes(token), `凭据泄漏：${path}`);
    assert.ok(!html.includes('FailedToLoadModuleSSR'), path);
    if (path === '/') homeCards = (await checkCards(html, '首页')).count;
  }
  const discoverResponse = await request('/discover/');
  assert.equal(discoverResponse.status, 200, '精选目录应可直接访问');
  const { ast: discoverAst } = await parse(await discoverResponse.text());
  const curatedCards = descendants(discoverAst, (node) => attr(node, 'data-curated-resource') !== undefined);
  assert.equal(curatedCards.length, RESOURCE_GROUPS.flatMap((group) => group.resources).length);
  for (const group of RESOURCE_GROUPS) {
    assert.equal(descendants(discoverAst, (node) => attr(node, 'id') === group.id).length, 1, '精选分组锚点应唯一');
    for (const resource of group.resources) {
      const card = curatedCards.find((node) => attr(node, 'data-curated-resource') === resource.id);
      assert.ok(card, resource.name + '：缺少精选卡片');
      const links = descendants(card, (node) => node.name === 'a');
      assert.ok(links.some((link) => attr(link, 'href') === resource.sourceUrl), resource.name + '：缺少来源');
      const visit = links.find((link) => hasClass(link, 'curated-card__visit'));
      assert.ok(visit, resource.name + '：缺少官网入口');
      assertOfficialLink(visit, resource, '精选目录 / ' + resource.name);
    }
  }
  const topbar = descendants(discoverAst, (node) => node.name === 'header' && hasClass(node, 'cyber-topbar'))[0];
  assert.ok(topbar, '缺少顶部导航');
  const topLinks = descendants(topbar, (node) => node.name === 'a');
  for (const group of RESOURCE_GROUPS) {
    assert.ok(topLinks.some((link) => attr(link, 'href') === '/discover/#' + group.id), '下拉应链接到对应精选分组');
    for (const resource of group.resources) {
      const link = topLinks.find((node) => attr(node, 'href') === resource.url);
      assert.ok(link, resource.name + '：缺少顶部直达入口');
      assertOfficialLink(link, resource, '顶部精选 / ' + resource.name);
    }
  }
  assert.ok(!topLinks.some((link) => ['/articles/', '/quick-search/'].includes(attr(link, 'href'))), '顶部不再推荐占位栏目');
  assert.ok((await (await request('/sitemap.xml')).text()).includes('/discover/'), 'sitemap应收录精选目录');
  console.log('精选导航回归通过：3组18项、官网与来源链接、分组锚点、占位入口移除、精选页与sitemap。');
  const fun = raw.categories.find((category) => category.slug === 'fun');
  assert.ok(fun, '缺少趣味网站分类');
  const funSite = raw.sites.find((site) => site.category === fun.id && site.name === '表情包混合');
  assert.ok(funSite, '缺少截图复现站点：趣味网站 / 表情包混合');
  const funPath = '/' + fun.slug + '/' + funSite.slug + '/';
  const funResponse = await request(funPath, { redirect: 'manual' });
  assert.equal(funResponse.status, 200, funPath + '：详情必须直接200，不能301自循环');
  assert.equal(funResponse.headers.get('Location'), null, funPath + '：详情不应重定向');
  const funHtml = await funResponse.text();
  assert.ok(funHtml.includes('同类推荐'), '趣味网站详情应保留同类推荐');
  const { ast: funAst, count: relatedCards } = await checkCards(funHtml, '趣味网站详情同类推荐');
  const articles = descendants(funAst, (node) => attr(node, 'data-detail-visit') !== undefined);
  assert.equal(articles.length, 1, '保留详情访问记录容器');
  assert.equal(attr(articles[0], 'data-site-id'), funSite.id);
  const visits = descendants(articles[0], (node) => node.name === 'a' &&
    descendants(node, (child) => child.type === 'text' && child.value.includes('访问官网')).length > 0);
  assert.equal(visits.length, 1, '详情仍应提供访问官网按钮');
  assertOfficialLink(visits[0], funSite, '详情访问官网按钮');
  const health = await (await request('/api/health')).json();
  assert.equal(health.data.databaseConnected, false);
  const categories = await (await request('/api/categories')).json();
  assert.equal(categories.data.length, raw.categories.length);
  const first = await (await request('/api/sites?pageSize=100')).json();
  assert.equal(first.pagination.total, raw.sites.length);
  assert.equal(first.data.length, 100);
  assert.ok(!('sources' in first.data[0]));
  const full = new Set();
  for (let page = 1; page <= first.pagination.totalPages; page++) {
    const result = await (await request(`/api/sites?pageSize=100&page=${page}`)).json();
    result.data.forEach((site) => full.add(site.id));
  }
  assert.equal(full.size, raw.sites.length, '服务端分页丢失站点');
  const sample = raw.sites[0];
  const detail = await (await request(`/api/sites/${sample.id}`)).json();
  assert.equal(detail.data.id, sample.id);
  assert.equal((await request('/api/sites/no-such-id')).status, 404);
  assert.equal((await request('/api/sites?pageSize=101')).status, 400);
  assert.equal((await request('/api/sites', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' })).status, 405);
  assert.equal((await request('/api/admin/status')).status, 401);
  assert.equal((await request('/api/admin/status', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
  const admin = await request('/api/admin/status', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('Cache-Control'), 'no-store');
  const status = await admin.json();
  assert.equal(status.data.storage.writable, false);
  assert.equal(status.data.counts.sites, raw.sites.length);
  const publicMenus = await request('/api/menus');
  assert.equal(publicMenus.status, 200);
  assert.equal(publicMenus.headers.get('Cache-Control'), 'no-store');
  const menuList = (await publicMenus.json()).data;
  assert.ok(menuList.length > 0 && menuList.every(m => m.enabled));
  assert.equal((await request('/api/admin/menus')).status, 401);
  const menuSnapshot = await (await request('/api/admin/menus', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(menuSnapshot.data.writable, false, 'seed菜单管理只读');
  assert.match(menuSnapshot.data.revision, /^[a-f0-9]{64}$/);
  const seedWrite = await request('/api/admin/menus', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({menus:menuSnapshot.data.menus, revision:menuSnapshot.data.revision}) });
  assert.equal(seedWrite.status, 503, 'seed菜单不可写');
  assert.equal((await seedWrite.json()).error.code, 'MENU_READ_ONLY');

  for (const path of ['/no-such-category/', '/ai/no-such-site/', '/ai/page/999/', '/ai/page/not-a-number/', '/.env', '/src/server/auth.ts']) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    const html = await response.text();
    assert.ok(html.includes('not-found__actions'), path + '：必须复用统一404页面');
    assert.ok(html.includes('noindex,follow'), path + '：404禁止索引');
  }
  assert.equal((await request('/entertainment/', { redirect: 'manual' })).status, 301);
  let redirects = 1;
  for (const site of raw.sites) {
    const canonical = `/${categoryById.get(site.category).slug}/${site.slug}/`;
    for (const source of site.sources.filter((source) => source.dataset === 'sites.json')) {
      const old = `/${source.recordId}/`;
      if (old === canonical) continue;
      const response = await request(old, { redirect: 'manual' });
      assert.equal(response.status, 301, old);
      assert.equal(new URL(response.headers.get('Location'), base).pathname, canonical, old);
      redirects++;
    }
  }
  const index = await (await request('/search-index.json')).json();
  assert.equal(index.sites.length, raw.sites.length);
  const sitemap = await (await request('/sitemap.xml')).text();
  const locations = new Set([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]).pathname));
  for (const site of raw.sites) assert.ok(locations.has(`/${categoryById.get(site.category).slug}/${site.slug}/`));
  // 每类选一个新详情，验证运行时路由而非残留静态文件。
  for (const category of raw.categories) {
    const site = raw.sites.find((site) => site.category === category.id);
    const path = `/${category.slug}/${site.slug}/`;
    assert.equal((await request(path, { redirect: 'manual' })).status, 200, path + '：详情不能重定向');
  }
  console.log(`全栈产物检查通过：Node独立启动、${raw.categories.length}分类、${full.size}站点、${redirects}旧链接301。`);
  console.log(`卡片跳转回归通过：首页${homeCards}张（含动态模板）、趣味详情推荐${relatedCards}张、独立收藏、官网按钮、详情直接200。`);
  console.log('API分页/搜索索引/管理鉴权/只读限制/404/运行时页面检查通过。');
} finally {
  server.kill();
  await new Promise((resolve) => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    setTimeout(resolve, 3000).unref();
  });
}





