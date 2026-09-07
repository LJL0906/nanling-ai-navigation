import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { parse } from '@astrojs/compiler';
import { SITE } from '../src/config/site.ts';

// 针对生产 SSR 产物，强制使用只读种子数据，不读取 .env、不写数据库。
const root = fileURLToPath(new URL('../', import.meta.url));
const entry = join(root, process.env.NAV_BUILD_DIR ?? 'dist', 'server/entry.mjs');
assert.ok(existsSync(entry), '请先执行 npm run build');
const raw = JSON.parse(readFileSync(join(root, 'src/data/导航数据.json'), 'utf8'));
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const port = probe.address().port;
    probe.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
let output = '';
const server = spawn(process.execPath, [entry], {
  cwd: root, windowsHide: true,
  env: { ...process.env, NAV_STORAGE: 'seed', HOST: '127.0.0.1', PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', chunk => { output = (output + chunk).slice(-8000); });
server.stderr.on('data', chunk => { output = (output + chunk).slice(-8000); });
const request = (path, options = {}) => fetch(base + path, {
  redirect: 'manual', signal: AbortSignal.timeout(30000), ...options,
});
const attr = (node, key) => node.attributes?.find(item => item.name === key)?.value;
function collect(node, predicate, result = []) {
  if (predicate(node)) result.push(node);
  for (const child of node.children ?? []) collect(child, predicate, result);
  return result;
}
const textOf = node => node.value ?? (node.children ?? []).map(textOf).join('');
async function inspect(path) {
  const response = await request(path);
  assert.equal(response.status, 200, path + ' 必须直接返回 200');
  assert.match(response.headers.get('content-type') ?? '', /text\/html/, path);
  const html = await response.text();
  // 仅将 head 交给 Astro 编译器；避免为每页重复解析整套 SVG/交互布局而消耗大量内存。
  const { ast } = await parse(html.slice(0, html.indexOf('</head>') + 7) + '<body></body></html>');
  const nodes = collect(ast, node => ['meta', 'link', 'title', 'h1', 'script', 'a', 'img'].includes(node.name));
  const metas = nodes.filter(node => node.name === 'meta');
  const meta = key => metas.filter(node => attr(node, 'name') === key || attr(node, 'property') === key);
  const titles = nodes.filter(node => node.name === 'title');
  assert.equal(titles.length, 1, path + ' 唯一标题');
  const title = textOf(titles[0]);
  assert.ok(title.trim(), path + ' 标题非空');
  assert.equal(meta('description').length, 1, path + ' 唯一描述');
  assert.ok(attr(meta('description')[0], 'content')?.trim(), path + ' 描述非空');
  const canonicals = nodes.filter(node => node.name === 'link' && attr(node, 'rel') === 'canonical');
  assert.equal(canonicals.length, 1, path + ' 唯一 canonical');
  const canonical = attr(canonicals[0], 'href');
  assert.equal(attr(meta('og:url')[0], 'content'), canonical, path + ' OG 与 canonical 一致');
  assert.equal([...html.matchAll(/<h1(?:\s|>)/g)].length, 1, path + ' 唯一 H1');
  for (const [image] of html.matchAll(/<img\b[^>]*>/g)) {
    assert.match(image, /\balt="[^"]*"/, path + ' 图片必须有 alt');
  }
  const structured = nodes.filter(node => node.name === 'script' && attr(node, 'type') === 'application/ld+json')
    .map(node => JSON.parse(textOf(node)));
  for (const item of structured) {
    assert.equal(item['@context'], 'https://schema.org', path + ' JSON-LD context');
    assert.ok(item['@type'], path + ' JSON-LD type');
  }
  return { title, canonical, structured, robots: attr(meta('robots')[0], 'content') ?? '',
    headerRobots: response.headers.get('x-robots-tag') ?? '',
    links: [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>/g)].map(match => match[1].replaceAll('&amp;', '&')) };
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(output);
    try { ready = (await request('/api/health')).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, '生产服务未就绪：' + output);
  const robots = await request('/robots.txt');
  assert.equal(robots.status, 200);
  assert.ok((await robots.text()).includes(`Sitemap: ${SITE.url}/sitemap.xml`));
  const sitemap = await request('/sitemap.xml');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get('content-type') ?? '', /application\/xml/);
  const xml = await sitemap.text();
  assert.ok(!xml.includes('<lastmod>'), '无真实逐页修改时间时不输出 lastmod');
  const locations = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1].replaceAll('&amp;', '&'));
  const paths = locations.map(loc => {
    const url = new URL(loc);
    assert.equal(url.origin, SITE.url, 'sitemap 使用正式域名');
    assert.equal(url.search, '', 'sitemap 不收录筛选参数');
    assert.ok(url.pathname.endsWith('/'), 'sitemap 使用规范斜线');
    assert.ok(!/^\/(admin|api|search|login|register|favorites|history|notifications|settings|404)(\/|$)/.test(url.pathname));
    return url.pathname;
  });
  assert.equal(new Set(paths).size, paths.length, 'sitemap 不重复');
  for (const category of raw.categories) {
    assert.ok(paths.includes(`/${category.slug}/`));
    for (const site of raw.sites.filter(site => site.category === category.id)) {
      assert.ok(paths.includes(`/${category.slug}/${site.slug}/`), site.id + ' 缺少 sitemap 条目');
    }
  }
  const all = process.argv.includes('--all');
  const samples = new Set(['/', '/categories/', '/tags/', '/discover/']);
  for (const category of raw.categories) {
    samples.add(`/${category.slug}/`);
    const site = raw.sites.find(site => site.category === category.id);
    if (site) samples.add(`/${category.slug}/${site.slug}/`);
  }
  for (const path of paths.filter(path => /\/page\/\d+\/$/.test(path))) samples.add(path);
  const queue = all ? paths : [...samples];
  const titles = new Map();
  const internalLinks = new Set();
  let cursor = 0;
  // 保持小并发，避免本地 SSR 验收挤占机器资源。
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < queue.length) {
      const path = queue[cursor++];
      if (cursor % 100 === 0) console.log(`已检查 ${cursor - 1}/${queue.length} 页`);
      const page = await inspect(path);
      assert.equal(page.canonical, SITE.url + path, path + ' 自引用 canonical');
      assert.ok(!page.robots.includes('noindex') && !page.headerRobots.includes('noindex'), path + ' sitemap 页面应可索引');
      assert.ok(page.structured.length > 0, path + ' 缺少结构化数据');
      assert.ok(!titles.has(page.title), `重复标题：${path} / ${titles.get(page.title)}`);
      titles.set(page.title, path);
      for (const href of page.links) {
        const url = new URL(href, SITE.url + path);
        if (url.origin === SITE.url && !url.search) internalLinks.add(url.pathname);
      }
    }
  }));
  for (const path of paths) assert.ok(path === '/' || internalLinks.has(path), path + ' 缺少可抓取内链');
  for (const path of ['/articles/', '/quick-search/']) {
    const response = await request(path);
    assert.equal(response.status, 404, path + '：已删除的占位页返回404');
  }
  for (const path of ['/search/?q=AI', '/login/', '/register/', '/favorites/', '/history/']) {
    const page = await inspect(path);
    assert.match(page.robots, /noindex/, path);
    assert.match(page.headerRobots, /noindex/, path + ' HTTP 禁止索引');
  }
  for (const [path, target] of [['/notifications/', '/?notifications=site'], ['/settings/', '/admin/login/']]) {
    const response = await request(path);
    assert.equal(response.status, 302, path);
    assert.equal(new URL(response.headers.get('location'), base).href, base + target);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, path);
  }
  for (const path of ['/no-such-category/', '/ai/no-such-site/', '/ai/page/999/', '/ai/page/01/', '/404/']) {
    const response = await request(path);
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, path);
  }
  for (const [from, to] of [['/categories', '/categories/'], ['/ai?utm_source=test', '/ai/?utm_source=test'], ['/ai/page/1/', '/ai/']]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await request(from, { method });
      assert.equal(response.status, 301, method + ' ' + from);
      assert.equal(new URL(response.headers.get('location'), base).href, base + to, from);
    }
  }
  for (const path of ['/api/health', '/search-index.json', '/personal-sites.json', '/history-destinations.json', '/api/admin/status', '/admin/']) {
    const response = await request(path);
    assert.match(response.headers.get('x-robots-tag') ?? '', /noindex/, path);
  }
  for (const query of ['sub=all', 'sub=', 'sub=missing']) {
    const filtered = await inspect('/ai/?' + query);
    assert.equal(filtered.canonical, SITE.url + '/ai/');
    assert.match(filtered.robots, /noindex/);
    assert.match(filtered.headerRobots, /noindex/);
  }
  console.log(`SEO生产验收通过：sitemap ${paths.length} URL，实际检查 ${queue.length} 页，全部详情可通过HTML内链发现。`);
  console.log('标题/H1/描述/canonical/OG/JSON-LD/图片alt/索引隔离/404/GET与HEAD规范重定向通过。');
} catch (error) {
  console.error('生产服务诊断：', { exitCode: server.exitCode, signalCode: server.signalCode }, output);
  throw error;
} finally {
  server.kill();
  await new Promise(resolve => {
    if (server.exitCode !== null) return resolve();
    server.once('exit', resolve);
    setTimeout(resolve, 3000).unref();
  });
}
