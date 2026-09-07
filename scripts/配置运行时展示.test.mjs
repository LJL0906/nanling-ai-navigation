import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { transform } from '@astrojs/compiler';
import { getHomeSectionSizes } from '../src/lib/home-sections.ts';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const consumers = [
  'src/layouts/BaseLayout.astro', 'src/components/layout/Sidebar.astro',
  'src/components/layout/PersonalPage.astro', 'src/components/layout/Logo.astro',
  'src/components/category/CategoryPage.astro', 'src/components/home/HomeNavigation.astro',
  'src/pages/index.astro', 'src/pages/404.astro', 'src/pages/login.astro',
  'src/pages/register.astro', 'src/pages/categories/index.astro',
  'src/pages/discover/index.astro', 'src/pages/search/index.astro',
  'src/pages/[category]/[slug].astro',
];
function evaluate(source, bindings, exports) {
  const code = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, '').replace(/export /g, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return vm.runInNewContext(`${code}\n;({${exports}})`, bindings);
}

test('配置按请求懒读取，同请求并发及嵌套消费共享 Promise，后续请求重新读取', async () => {
  let reads = 0;
  const { onRequest } = evaluate(read('src/middleware.ts'), {
    getRuntimeSettings: async () => ({ site: { name: `品牌${++reads}` }, homeSectionPageSize: 7 }),
    getAdminSession: () => null, safeAdminNext: (path) => path,
  }, 'onRequest');
  const makeContext = () => ({ url: new URL('https://example.test/'), locals: {}, request: new Request('https://example.test/') });
  const response = () => new Response('', { headers: { 'Content-Type': 'text/html' } });
  await onRequest(makeContext(), async () => response());
  assert.equal(reads, 0);
  for (let expected = 1; expected <= 2; expected++) {
    const context = makeContext();
    await onRequest(context, async () => {
      const first = context.locals.getRuntimeSettings();
      assert.equal(first, context.locals.getRuntimeSettings());
      const values = await Promise.all([first, context.locals.getRuntimeSettings()]);
      assert.equal(values[0], values[1]);
      assert.equal(values[0].site.name, `品牌${expected}`);
      return response();
    });
  }
  assert.equal(reads, 2);
});

test('SEO factory 使用传入品牌和域名，不污染兼容默认节点', () => {
  const defaults = { url: 'https://seed.test', name: '种子', description: '默认简介' };
  const { createWebsiteNode, websiteNode } = evaluate(read('src/lib/seo.ts'), { SITE: defaults }, 'createWebsiteNode, websiteNode');
  const site = { url: 'https://runtime.test', name: '运行时品牌', description: '运行时简介' };
  const node = createWebsiteNode(site);
  assert.equal(node['@id'], `${site.url}/#website`);
  assert.equal(node.name, site.name);
  assert.equal(node.alternateName, site.name);
  assert.equal(node.description, site.description);
  assert.equal(websiteNode.name, defaults.name);
  assert.equal(defaults.url, 'https://seed.test');
});

test('首页 SSR、无 JS 提示及客户端 Tab/更多共用服务器数量，保留种子默认值', () => {
  assert.deepEqual(getHomeSectionSizes(7), { pageSize: 7, moreSize: 14 });
  assert.deepEqual(getHomeSectionSizes(18), { pageSize: 18, moreSize: 36 });
  for (const value of [NaN, 0, -1, 1.5, Infinity]) {
    assert.deepEqual(getHomeSectionSizes(value), { pageSize: 18, moreSize: 36 });
  }
  const template = read('src/components/home/HomeNavigation.astro');
  assert.match(template, /homeSectionPageSize: pageSize/);
  assert.match(template, /data-home-page-size=\{pageSize\}/);
  assert.match(template, /sites\.slice\(0, pageSize\)/);
  assert.match(template, /最多 \{pageSize\} 个站点/);
  const client = read('src/scripts/homeNavigation.ts');
  assert.match(client, /getHomeSectionSizes\(Number\(root.dataset.homePageSize\)\)/);
  assert.match(client, /append \? moreSize : pageSize/);
});

test('前台模板可编译且不再静态导入 SITE 或 websiteNode', async () => {
  for (const path of consumers) {
    const source = read(path);
    assert.match(source, /Astro.locals.getRuntimeSettings\(\)/, path);
    assert.doesNotMatch(source, /import \{ (?:SITE|websiteNode)[, }]/, path);
    const result = await transform(source);
    assert.equal(result.diagnostics.filter((item) => item.severity === 1).length, 0, path);
  }
  const home = read('src/pages/index.astro');
  assert.match(home, /SITE.heroTitle/);
  assert.match(home, /SITE.heroSubtitle/);
});

test('sitemap 域名逐请求读取并转义 XML，不引入 lastmod', async () => {
  const { GET } = evaluate(read('src/pages/sitemap.xml.ts'), {
    getNavigation: async () => ({ categories: [] }), PAGE_SIZE: 48, Response,
  }, 'GET');
  for (const url of ['https://one.test', 'https://two.test/a&b']) {
    const response = await GET({ locals: { getRuntimeSettings: async () => ({ site: { url } }) } });
    const xml = await response.text();
    assert.ok(xml.includes(`<loc>${url.replace(/&/g, '&amp;')}/</loc>`));
    assert.ok(!xml.includes('lastmod'));
  }
});
