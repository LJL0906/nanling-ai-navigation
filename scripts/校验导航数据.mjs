import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 对应 src/pages 中的静态一级路由；新增静态页面时同步维护。
export const RESERVED_ROUTES = Object.freeze([
  'index', '404', 'admin', 'api', 'login', 'register', 'articles', 'categories', 'entertainment', 'favorites', 'history',
  'notifications', 'quick-search', 'search', 'settings', 'tags', 'sitemap.xml',
  'search-index.json',
]);
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ICONIFY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*:[a-z0-9]+(?:-[a-z0-9]+)*$/;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function parseHttpUrl(value) {
  if (!isText(value) || !/^https?:\/\/[^/?#]/i.test(value) || /[\s\\\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('必须为完整、无空白的 HTTP(S) URL');
  }
  const url = new URL(value);
  if (!url.hostname) throw new Error('URL 缺少主机名');
  return url;
}

/** 仅规范化站点身份，不改写原始 URL、不请求网络。保留实际路径与业务查询参数。 */
export function normalizeUrl(value) {
  const url = parseHttpUrl(value);
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key) || ['ref', 'from', 'inviter'].includes(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  const query = url.searchParams.toString();
  const credentials = url.username || url.password ? `${url.username}:${url.password}@` : '';
  return `${credentials}${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}${query ? `?${query}` : ''}`;
}

/**
 * 纯校验函数：不读写文件、不联网、不修改/过滤输入。
 * iconifyCollections 可注入本地图标集合（prefix -> { icons, aliases }）；省略时只检查结构。
 * legacyData 必须传入旧 sites.json，以确保精选站点没有丢失。
 */
export function validateNavigationData(data, legacyData, { iconifyCollections } = {}) {
  const errors = [];
  const stats = { categories: 0, sites: 0, unverified: 0, legacySites: 0, legacyMatched: 0 };
  const result = () => ({ valid: errors.length === 0, errors, stats });
  const fail = (path, message) => errors.push(`${path}：${message}`);
  const text = (value, path) => { if (!isText(value)) fail(path, '必须为非空字符串'); };
  const array = (value, path) => {
    if (Array.isArray(value)) return value;
    fail(path, '必须为数组');
    return [];
  };
  const integer = (value, path) => {
    if (!Number.isSafeInteger(value) || value < 0) fail(path, '必须为非负安全整数');
  };
  const equal = (actual, expected, path) => {
    if (actual !== expected) fail(path, `统计不一致，记录值 ${actual}，实际应为 ${expected}`);
  };
  const identity = (value, path) => {
    try { return normalizeUrl(value); }
    catch { fail(path, '必须为有效的 HTTP(S) URL（不允许空白或反斜杠）'); return null; }
  };
  const unique = (value, seen, path) => {
    text(value, path);
    if (!isText(value)) return;
    if (seen.has(value)) fail(path, `重复值 ${value}`);
    seen.add(value);
  };
  const slug = (value, path) => {
    if (typeof value !== 'string' || !SAFE_SLUG.test(value)) {
      fail(path, 'slug 不安全，只允许小写字母、数字及中间的单个连字符');
    }
  };
  const iconify = (value, path) => {
    if (typeof value !== 'string' || !ICONIFY_NAME.test(value)) {
      fail(path, 'Iconify 名称必须为 prefix:name 格式');
      return;
    }
    if (iconifyCollections !== undefined) {
      const [prefix, name] = value.split(':');
      const collection = iconifyCollections?.[prefix];
      if (!Object.hasOwn(collection?.icons ?? {}, name) && !Object.hasOwn(collection?.aliases ?? {}, name)) {
        fail(path, `本地图标集合中不存在 ${value}（已检查 icons 和 aliases）`);
      }
    }
  };
  const siteIcon = (icon, path) => {
    if (icon === null) return;
    if (!isObject(icon)) { fail(path, '必须为 null 或图标对象'); return; }
    text(icon.value, `${path}.value`);
    if (icon.type === 'iconify') iconify(icon.value, `${path}.value`);
    else if (icon.type === 'url') identity(icon.value, `${path}.value`);
    else if (icon.type !== 'raw') fail(`${path}.type`, '仅支持 iconify、url、raw；无图标请使用 null');
    if (icon.color !== undefined) text(icon.color, `${path}.color`);
  };

  if (!isObject(data)) { fail('数据', '根节点必须为对象'); return result(); }
  const categories = array(data.categories, 'categories');
  const sites = array(data.sites, 'sites');
  stats.categories = categories.length;
  stats.sites = sites.length;
  const categoryIds = new Set();
  const categorySlugs = new Set();
  const categoryCounts = new Map();
  categories.forEach((category, index) => {
    const path = `categories[${index}]`;
    if (!isObject(category)) { fail(path, '必须为对象'); return; }
    unique(category.id, categoryIds, `${path}.id`);
    slug(category.slug, `${path}.slug`);
    unique(category.slug, categorySlugs, `${path}.slug`);
    if (RESERVED_ROUTES.includes(category.slug)) fail(`${path}.slug`, `与保留静态路由 /${category.slug}/ 冲突`);
    text(category.name, `${path}.name`);
    iconify(category.icon, `${path}.icon`);
    integer(category.order, `${path}.order`);
    if (typeof category.color !== 'string' || !/^#[\da-f]{6}$/i.test(category.color)) {
      fail(`${path}.color`, '必须为六位十六进制颜色');
    }
    integer(category.count, `${path}.count`);
    categoryCounts.set(category.id, 0);
  });

  const siteIds = new Set();
  const siteRoutes = new Set();
  const urls = new Map();
  const legacySources = new Map();
  const sourceCounts = new Map();
  let duplicateGroups = 0;
  let sourceReferences = 0;
  let lowConfidence = 0;
  sites.forEach((site, index) => {
    const path = `sites[${index}]`;
    if (!isObject(site)) { fail(path, '必须为对象'); return; }
    unique(site.id, siteIds, `${path}.id`);
    slug(site.slug, `${path}.slug`);
    const route = JSON.stringify([site.category, site.slug]);
    if (siteRoutes.has(route)) fail(`${path}.slug`, `分类 ${site.category} 内 slug 重复：${site.slug}`);
    siteRoutes.add(route);
    text(site.name, `${path}.name`);
    if (!categoryIds.has(site.category)) fail(`${path}.category`, `引用不存在的分类 ${site.category}`);
    else categoryCounts.set(site.category, categoryCounts.get(site.category) + 1);
    const normalized = identity(site.url, `${path}.url`);
    if (normalized !== null) {
      if (urls.has(normalized)) fail(`${path}.url`, `规范化 URL 重复，与 ${urls.get(normalized)} 相同：${normalized}`);
      urls.set(normalized, path);
    }
    const alternateIdentities = array(site.alternateUrls, `${path}.alternateUrls`)
      .map((url, n) => identity(url, `${path}.alternateUrls[${n}]`));
    siteIcon(site.icon, `${path}.icon`);
    if (typeof site.description !== 'string') fail(`${path}.description`, '必须为字符串，空字符串由适配层提供兜底');
    text(site.domain, `${path}.domain`);
    for (const field of ['aliases', 'sourceCategories']) {
      array(site[field], `${path}.${field}`).forEach((value, n) => text(value, `${path}.${field}[${n}]`));
    }
    const tags = array(site.tags, `${path}.tags`);
    tags.forEach((tag, n) => text(tag, `${path}.tags[${n}]`));
    if (tags.includes('多来源合并')) duplicateGroups++;
    if (!isObject(site.verification) || !isText(site.verification.status)) {
      fail(`${path}.verification.status`, '必须为非空字符串；unverified 是合法状态');
    } else if (site.verification.status === 'unverified') stats.unverified++;
    if (site.classification !== undefined) {
      if (!isObject(site.classification)) fail(`${path}.classification`, '必须为对象');
      else {
        equal(site.classification.category, site.category, `${path}.classification.category`);
        if (site.classification.confidence === 'low') lowConfidence++;
      }
    }
    const sources = array(site.sources, `${path}.sources`);
    if (sources.length === 0) fail(`${path}.sources`, '至少保留一条来源记录');
    if (sources.length > 1 && !tags.includes('多来源合并')) fail(`${path}.tags`, '多条来源记录缺少“多来源合并”标签');
    sources.forEach((source, n) => {
      const sourcePath = `${path}.sources[${n}]`;
      if (!isObject(source)) { fail(sourcePath, '必须为对象'); return; }
      text(source.dataset, `${sourcePath}.dataset`);
      text(source.recordId, `${sourcePath}.recordId`);
      sourceReferences++;
      sourceCounts.set(source.dataset, (sourceCounts.get(source.dataset) ?? 0) + 1);
      if (source.dataset !== 'sites.json') return;
      // 一个统一站点可以对应多个旧 recordId（例如 bilibili），但同一旧记录不能指向多个站点。
      const previous = legacySources.get(source.recordId);
      if (previous && previous.index !== index) fail(sourcePath, `旧精选记录 ${source.recordId} 对应多个统一站点`);
      const originalIdentity = identity(source.originalUrl, `${sourcePath}.originalUrl`);
      legacySources.set(source.recordId, { index, normalized, alternateIdentities, originalIdentity });
    });
  });
  categories.forEach((category, index) => {
    if (isObject(category)) equal(category.count, categoryCounts.get(category.id), `categories[${index}].count`);
  });

  const expectedLegacy = new Set();
  if (!isObject(legacyData)) fail('旧 sites.json', '必须提供旧精选数据对象，以检查来源覆盖');
  else array(legacyData.categories, '旧 sites.json.categories').forEach((category, index) => {
    const path = `旧 sites.json.categories[${index}]`;
    if (!isObject(category)) { fail(path, '必须为对象'); return; }
    slug(category.slug, `${path}.slug`);
    array(category.sites, `${path}.sites`).forEach((site, n) => {
      stats.legacySites++;
      if (!isObject(site)) { fail(`${path}.sites[${n}]`, '必须为对象'); return; }
      slug(site.slug, `${path}.sites[${n}].slug`);
      const recordId = `${category.slug}/${site.slug}`;
      unique(recordId, expectedLegacy, `${path}.sites[${n}] 来源标识`);
      const expectedUrl = identity(site.url, `${path}.sites[${n}].url`);
      const matched = legacySources.get(recordId);
      if (!matched) { fail('旧精选覆盖', `缺少 sources.dataset='sites.json' + recordId='${recordId}'`); return; }
      if (expectedUrl === null || matched.originalIdentity !== expectedUrl
        || ![matched.normalized, ...matched.alternateIdentities].includes(expectedUrl)) {
        fail('旧精选覆盖', `${recordId} 的来源网址或统一站点网址不匹配`);
      } else stats.legacyMatched++;
    });
  });
  for (const recordId of legacySources.keys()) {
    if (!expectedLegacy.has(recordId)) fail('旧精选覆盖', `未知的 sites.json recordId：${recordId}`);
  }

  if (!isObject(data.meta) || !isObject(data.meta.stats)) {
    fail('meta.stats', '必须为统计对象');
    return result();
  }
  const meta = data.meta;
  const counts = meta.stats;
  for (const key of ['sourceRecords', 'parsedValidRecords', 'uniqueSites', 'duplicateRecordsMerged', 'duplicateGroups', 'excludedRecords', 'categories']) {
    integer(counts[key], `meta.stats.${key}`);
  }
  equal(counts.uniqueSites, sites.length, 'meta.stats.uniqueSites');
  equal(counts.categories, categories.length, 'meta.stats.categories');
  equal(counts.sourceRecords, counts.parsedValidRecords + counts.excludedRecords, 'meta.stats.sourceRecords');
  equal(counts.parsedValidRecords, sites.length + counts.duplicateRecordsMerged, 'meta.stats.parsedValidRecords');
  // sources 自身会去重：当前 2494 条有效原始记录只保留 2477 条来源，不能直接要求二者相等。
  equal(counts.duplicateGroups, duplicateGroups, 'meta.stats.duplicateGroups');
  if (counts.duplicateGroups > counts.duplicateRecordsMerged) fail('meta.stats.duplicateGroups', '不能超过合并重复记录数');
  if (sourceReferences > counts.parsedValidRecords) fail('meta.stats.parsedValidRecords', '不能少于已保留的来源记录数');
  if (counts.reclassified !== undefined) {
    integer(counts.reclassified, 'meta.stats.reclassified');
    // 数据未保留重分类前快照，只能验证历史计数的范围，不能从当前分类反推。
    if (counts.reclassified > sites.length) fail('meta.stats.reclassified', '不能超过站点总数');
  }
  if (counts.lowConfidence !== undefined) {
    integer(counts.lowConfidence, 'meta.stats.lowConfidence');
    equal(counts.lowConfidence, lowConfidence, 'meta.stats.lowConfidence');
  }
  const declaredSources = new Map();
  const sourceNames = new Set();
  let sourceTotal = 0;
  array(meta.sources, 'meta.sources').forEach((source, index) => {
    const path = `meta.sources[${index}]`;
    if (!isObject(source)) { fail(path, '必须为对象'); return; }
    unique(source.file, sourceNames, `${path}.file`);
    integer(source.recordCount, `${path}.recordCount`);
    sourceTotal += source.recordCount;
    declaredSources.set(source.file, source.recordCount);
  });
  equal(counts.sourceRecords, sourceTotal, 'meta.sources 记录总数');
  const exclusions = array(meta.exclusions, 'meta.exclusions');
  equal(counts.excludedRecords, exclusions.length, 'meta.stats.excludedRecords');
  const excludedCounts = new Map();
  exclusions.forEach((exclusion, index) => {
    if (!isObject(exclusion) || !declaredSources.has(exclusion.source)) fail(`meta.exclusions[${index}]`, '必须引用已声明的数据来源');
    else excludedCounts.set(exclusion.source, (excludedCounts.get(exclusion.source) ?? 0) + 1);
  });
  for (const dataset of sourceCounts.keys()) {
    if (!declaredSources.has(dataset)) fail('sources.dataset', `未在 meta.sources 声明来源 ${dataset}`);
  }
  for (const [dataset, total] of declaredSources) {
    if ((sourceCounts.get(dataset) ?? 0) + (excludedCounts.get(dataset) ?? 0) > total) {
      fail('meta.sources', `${dataset} 的来源引用数与排除数之和超过原始记录数`);
    }
  }
  if (declaredSources.has('sites.json')) equal(declaredSources.get('sites.json'), stats.legacySites, 'meta.sources sites.json 精选记录数');
  return result();
}

async function main() {
  try {
    const root = new URL('../', import.meta.url);
    const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
    const data = await readJson('src/data/导航数据.json');
    const legacy = await readJson('src/data/sites.json');
    const collections = {};
    const names = [
      ...(Array.isArray(data?.categories) ? data.categories.map((category) => category?.icon) : []),
      ...(Array.isArray(data?.sites) ? data.sites.filter((site) => site?.icon?.type === 'iconify').map((site) => site.icon.value) : []),
    ];
    for (const prefix of new Set(names.filter((name) => typeof name === 'string' && ICONIFY_NAME.test(name)).map((name) => name.split(':')[0]))) {
      collections[prefix] = await readJson(`node_modules/@iconify-json/${prefix}/icons.json`);
    }
    const report = validateNavigationData(data, legacy, { iconifyCollections: collections });
    const { categories, sites, unverified, legacyMatched, legacySites } = report.stats;
    console.log(`导航数据：${categories} 个分类，${sites} 个站点。`);
    console.log(`未验证（unverified）：${unverified} 个；未验证不代表无效，全部保留并参与校验。`);
    console.log(`旧精选来源覆盖：${legacyMatched}/${legacySites} 条（允许多个旧记录合并为一个站点）。`);
    if (!report.valid) {
      console.error(`导航数据校验失败，共 ${report.errors.length} 项：\n${report.errors.map((error) => `- ${error}`).join('\n')}`);
      process.exitCode = 1;
    } else console.log('导航数据校验通过（含本地 Iconify icons/aliases 检查；未联网检测链接）。');
  } catch (error) {
    console.error(`导航数据校验失败：${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();




