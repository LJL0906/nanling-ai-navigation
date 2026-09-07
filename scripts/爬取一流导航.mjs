import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPOSITORY_URL = 'https://github.com/yiliudz/yiliudz.github.io';
const RAW_INDEX_URL = 'https://raw.githubusercontent.com/yiliudz/yiliudz.github.io/main/index.html';
const COMMIT_API_URL = 'https://api.github.com/repos/yiliudz/yiliudz.github.io/commits/main';
const OUTPUT_PATH = resolve('src/data/yiliudz-sites.json');

const inputArg = process.argv.find((arg) => arg.startsWith('--input='));

function decodeHtml(value = '') {
  const entities = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };

  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
      if (entity[0] === '#') {
        const hexadecimal = entity[1].toLowerCase() === 'x';
        const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _;
      }
      return entities[entity.toLowerCase()] ?? _;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMeta(html, name) {
  const match = html.match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'));
  return decodeHtml(match?.[1]);
}

function extractAttribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}=["']([^"']*)["']`, 'i'));
  return match?.[1] ?? null;
}

function parseBreadcrumbCategories(html) {
  const categories = new Map();
  const pattern = /<li[^>]+class="[^"]*category-item[^"]*"[^>]+data-id="(\d+)"[^>]*>\s*<a[^>]*>(.*?)<\/a>/gis;
  for (const match of html.matchAll(pattern)) {
    categories.set(decodeHtml(match[2]), Number(match[1]));
  }
  return categories;
}

function parseCategories(html) {
  const categoryIds = parseBreadcrumbCategories(html);
  const start = html.indexOf('<div id="toollist">');
  const endCandidates = [
    html.indexOf('<script', start),
    html.indexOf('${value.type.name}', start),
  ].filter((position) => position > start);
  const end = Math.min(...endCandidates);
  const toolList = html.slice(start, end);
  const headingPattern = /<span class="nk-menu-text font-weight-bold">(.*?)<\/span>/gis;
  const headings = [...toolList.matchAll(headingPattern)];

  return headings.map((heading, index) => {
    const name = decodeHtml(heading[1]);
    const sectionEnd = headings[index + 1]?.index ?? toolList.length;
    const section = toolList.slice(heading.index, sectionEnd);
    const sites = [];
    const linkPattern = /<a\b(?<attributes>[^>]*\bclass="[^"]*\btool-link\b[^"]*"[^>]*)>(?<name>[\s\S]*?)<\/a>/gi;

    for (const link of section.matchAll(linkPattern)) {
      const attributes = link.groups.attributes;
      const url = decodeHtml(extractAttribute(attributes, 'href'));
      if (!/^https?:\/\//i.test(url)) continue;

      sites.push({
        id: Number(extractAttribute(attributes, 'data-id')),
        name: decodeHtml(link.groups.name),
        url,
        rel: extractAttribute(attributes, 'rel'),
        target: extractAttribute(attributes, 'target'),
      });
    }

    return {
      id: categoryIds.get(name) ?? null,
      name,
      sites,
    };
  }).filter((category) => category.sites.length > 0);
}

function parseHeaderLinks(html) {
  const headerEnd = html.indexOf('<div class="nk-content nk-content-lg nk-content-fluid pt-5 pb-5 bannerbg">');
  const header = html.slice(0, headerEnd);
  const links = [];
  const pattern = /<a\b(?<attributes>[^>]*)>(?<name>[\s\S]*?)<\/a>/gi;

  for (const link of header.matchAll(pattern)) {
    const url = decodeHtml(extractAttribute(link.groups.attributes, 'href'));
    if (!/^https?:\/\//i.test(url)) continue;
    links.push({ name: decodeHtml(link.groups.name), url });
  }
  return links;
}

async function loadSource() {
  if (inputArg) {
    const inputPath = resolve(inputArg.slice('--input='.length));
    return { html: await readFile(inputPath, 'utf8'), commit: null, input: inputPath };
  }

  const [htmlResponse, commitResponse] = await Promise.all([
    fetch(RAW_INDEX_URL),
    fetch(COMMIT_API_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'navigationWebsite-scraper' } }),
  ]);
  if (!htmlResponse.ok) throw new Error(`下载源页面失败：HTTP ${htmlResponse.status}`);

  const commit = commitResponse.ok ? (await commitResponse.json()).sha : null;
  return { html: await htmlResponse.text(), commit, input: RAW_INDEX_URL };
}

const { html, commit, input } = await loadSource();
const categories = parseCategories(html);
const siteCount = categories.reduce((total, category) => total + category.sites.length, 0);

if (categories.length === 0 || siteCount === 0) {
  throw new Error('没有解析到分类或网站，源页面结构可能已经变化。');
}

const data = {
  source: {
    repository: REPOSITORY_URL,
    input,
    branch: 'main',
    commit,
    pageTitle: decodeHtml(html.match(/<title>(.*?)<\/title>/is)?.[1]),
    description: extractMeta(html, 'description'),
    keywords: extractMeta(html, 'keywords'),
    collectedAt: new Date().toISOString(),
  },
  stats: {
    categoryCount: categories.length,
    siteCount,
    headerLinkCount: parseHeaderLinks(html).length,
  },
  headerLinks: parseHeaderLinks(html),
  categories,
};

await writeFile(OUTPUT_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(`已写入 ${OUTPUT_PATH}`);
console.log(`共收集 ${data.stats.categoryCount} 个分类、${data.stats.siteCount} 个网站、${data.stats.headerLinkCount} 个页头外链。`);
