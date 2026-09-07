import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { transform } from '@astrojs/compiler';
import { paginateCategory } from '../src/lib/category-facets.ts';

const categorySource = readFileSync(new URL('../src/components/category/CategoryPage.astro', import.meta.url), 'utf8');
const detailSource = readFileSync(new URL('../src/pages/[category]/[slug].astro', import.meta.url), 'utf8');
const SITE = { url: 'https://example.test', name: '测试导航' };
const category = { slug: 'tools', name: '工具', desc: '真实分类描述。', keywords: '工具', sites: Array.from({ length: 100 }, (_, i) => ({
  id: `id-${i}`, slug: `tool-${i}`, categorySlug: 'tools', name: `工具${i}`, desc: `真实描述${i}`,
  url: `https://tool-${i}.test/`, tags: i < 50 ? ['写作'] : [], aliases: ['别名', '别名'],
})) };
const breadcrumb = (entries) => ({ type: 'breadcrumb', entries });
const itemList = (name, entries) => ({ type: 'list', name, entries });
async function evaluate(source, Astro, values, extra = {}) {
  Astro = { ...Astro, locals: { getRuntimeSettings: async () => ({ site: SITE, homeSectionPageSize: 18 }) } };
  const frontmatter = source.split('---')[1].replace(/^import .*;\r?\n/gm, '').replace('export const prerender = false;', '');
  const code = ts.transpileModule(`(async () => {${frontmatter}\nreturn { ${values} };})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return vm.runInNewContext(code, { Astro, SITE, PAGE_SIZE: 48, paginateCategory, domainOf: (site) => new URL(site.url).hostname, createWebsiteNode: (site) => ({ name: site.name, url: site.url }), breadcrumb, itemList, ...extra });
}
const categoryState = (path, page = 1) => evaluate(categorySource, {
  url: new URL(path, SITE.url), props: { category, page },
}, 'canonical, robots, page, pageSites, ld, detailHref, pageHref');

test('两个 Astro 模板可编译', async () => {
  for (const source of [categorySource, detailSource]) {
    const result = await transform(source);
    assert.equal(result.diagnostics.filter((item) => item.severity === 1).length, 0);
  }
});

test('普通分页各自 canonical，跟踪参数不进入 canonical，列表链接对应当前页', async () => {
  for (const page of [1, 2, 3]) {
    const path = page === 1 ? '/tools/' : `/tools/page/${page}/`;
    const state = await categoryState(`${path}?utm_source=test`, page);
    assert.equal(state.canonical, SITE.url + path);
    assert.equal(state.robots, 'index,follow');
    assert.deepEqual(Array.from(state.ld.at(-1).entries, (item) => item.url),
      Array.from(state.pageSites, (item) => SITE.url + state.detailHref(item)));
    assert.equal(state.pageSites[0].id, `id-${(page - 1) * 48}`);
  }
});

test('有效、无效、空、all 与重复筛选参数均 noindex，canonical 归分类首页', async () => {
  for (const query of ['sub=label%3A写作', 'sub=missing', 'sub=', 'sub=all', 'sub=all&sub=label%3A写作']) {
    const state = await categoryState(`/tools/?${query}`);
    assert.equal(state.robots, 'noindex,follow');
    assert.equal(state.canonical, SITE.url + '/tools/');
  }
});

test('筛选先于分页，过期筛选页 noindex 且链接使用实际页码', async () => {
  const state = await categoryState('/tools/page/3/?sub=label%3A写作', 3);
  assert.equal(state.page, 2);
  assert.equal(state.pageSites.length, 2);
  assert.equal(state.robots, 'noindex,follow');
  assert.equal(state.pageHref(2), '/tools/page/2/?sub=label%3A%E5%86%99%E4%BD%9C');
  assert.equal((await categoryState('/tools/page/99/', 99)).robots, 'noindex,follow');
});

test('分类卡片主入口保持官网，新详情锚点独立于收藏并处于遮罩上层', () => {
  assert.match(categorySource, /<a href=\{site.url\} target="_blank" rel="noopener noreferrer" class="category-site-link/);
  assert.match(categorySource, /href=\{detailHref\(site\)\}[\s\S]*?class="nav-card-external/);
  assert.match(categorySource, /<span class="sr-only">查看 \{site.name\} 详情<\/span>/);
  assert.match(categorySource, /\.nav-card-external\s*\{ z-index: 2;/);
  assert.match(categorySource, /<FavoriteButton siteId=\{site.id\} name=\{site.name\}/);
  assert.match(categorySource, /robots=\{robots\}/);
});

test('详情仅使用真实字段，同类列表结构化数据对应可见详情链接', async () => {
  const site = category.sites[0];
  const state = await evaluate(detailSource, { params: { category: 'tools', slug: site.slug } },
    'canonical, description, ld, aliases, tags, related, detailHref', {
      getNavigation: async () => ({ categories: [category], siteRedirects: [] }),
      relatedSites: (group, current) => group.sites.filter((item) => item.id !== current.id).slice(0, 6),
    });
  assert.equal(state.canonical, SITE.url + '/tools/tool-0/');
  assert.equal(state.ld[1].mainEntity.description, site.desc);
  assert.equal(state.ld[1].mainEntity.url, site.url);
  assert.equal(state.ld[1].mainEntity.alternateName.length, 1);
  assert.deepEqual(Array.from(state.ld.at(-1).entries, (item) => item.url),
    Array.from(state.related, (item) => SITE.url + state.detailHref(item)));
  assert.match(detailSource, /href=\{detailHref\(item\)\}/);
  assert.match(detailSource, /<SiteCard site=\{item\}/);
  assert.match(detailSource, /\{site.desc\}\s*<\/p>/);
  assert.doesNotMatch(detailSource, /aggregateRating|reviewRating|offers|priceCurrency|SoftwareApplication/);
});

test('历史永久跳转与不存在详情处理保持不变', () => {
  assert.match(detailSource, /Astro.redirect\(redirect.to, 301\)/);
  assert.match(detailSource, /if \(!category \|\| !site\)\s*\{\s*return Astro.rewrite\('\/404\/'\)/);
});

test('同名站点标题按真实域名及路径区分，不改变原始名称', async () => {
  const sites = [
    { ...category.sites[0], name: '同名工具', url: 'https://same.test/' },
    { ...category.sites[1], name: '同名工具', url: 'https://same.test/editor' },
    { ...category.sites[2], name: '同名工具', url: 'https://other.test/' },
  ].map(site => ({ ...site, domain: new URL(site.url).hostname }));
  const group = { ...category, sites };
  const titles = [];
  for (const site of sites) {
    const state = await evaluate(detailSource, { params: { category: 'tools', slug: site.slug } },
      'title, description, ld', {
        getNavigation: async () => ({ categories: [group], siteRedirects: [] }),
        relatedSites: () => [],
      });
    titles.push(state.title);
    assert.ok(state.title.includes(site.domain));
    assert.equal(state.ld[1].mainEntity.name, '同名工具');
  }
  assert.equal(new Set(titles).size, sites.length);
  assert.ok(titles[1].includes('same.test/editor'));
});
