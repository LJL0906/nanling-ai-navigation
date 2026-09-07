import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, copyFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeUrl, RESERVED_ROUTES, validateNavigationData } from './校验导航数据.mjs';

const script = fileURLToPath(new URL('./校验导航数据.mjs', import.meta.url));
const localIcons = { lucide: { icons: { sparkles: {} }, aliases: { sparkle: { parent: 'sparkles' } } } };

function fixture() {
  const legacy = {
    categories: [
      { slug: 'ai', sites: [{ slug: 'chat', url: 'https://www.example.com/' }] },
      { slug: 'tools', sites: [{ slug: 'tool', url: 'https://tool.example.com/' }] },
    ],
  };
  const sites = legacy.categories.map((category, index) => ({
    id: `site_${index}`, slug: 'chat', name: `示例站点 ${index}`, category: category.slug,
    url: category.sites[0].url, alternateUrls: [], tags: [],
    description: '', domain: new URL(category.sites[0].url).hostname, aliases: [], sourceCategories: [],
    icon: index === 0 ? null : { type: 'iconify', value: 'lucide:sparkles' },
    sources: [{ dataset: 'sites.json', recordId: `${category.slug}/${category.sites[0].slug}`, originalUrl: category.sites[0].url }],
    verification: { status: 'unverified', checkedAt: null },
    classification: { category: category.slug, confidence: 'high', reason: '测试数据' },
  }));
  const data = {
    categories: legacy.categories.map((category) => ({
      id: category.slug, slug: category.slug, name: '测试分类', count: 1, icon: 'lucide:sparkles', order: 0, color: '#3777f5',
    })),
    sites,
    meta: {
      stats: { sourceRecords: 2, parsedValidRecords: 2, uniqueSites: 2, duplicateRecordsMerged: 0, duplicateGroups: 0, excludedRecords: 0, categories: 2, reclassified: 0, lowConfidence: 0 },
      sources: [{ file: 'sites.json', recordCount: 2 }], exclusions: [],
    },
  };
  return { data, legacy };
}

function check(data, legacy) {
  return validateNavigationData(data, legacy, { iconifyCollections: localIcons });
}

function rejectsChange(name, mutate, expected) {
  test(name, () => {
    const { data, legacy } = fixture();
    mutate(data, legacy);
    const report = check(data, legacy);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), expected);
  });
}

test('有效数据通过，同名 slug 可以分属不同分类，unverified 不会被过滤', () => {
  const { data, legacy } = fixture();
  const report = check(data, legacy);
  assert.deepEqual(report.errors, []);
  assert.equal(report.valid, true);
  assert.deepEqual(report.stats, { categories: 2, sites: 2, unverified: 2, legacySites: 2, legacyMatched: 2 });
});

test('保留路由只约束分类 slug，不误拒分类 ID 或分类内站点 slug', () => {
  const { data, legacy } = fixture();
  data.categories[0].id = 'search';
  data.categories[0].slug = 'search-engines';
  data.sites[0].category = 'search';
  data.sites[0].classification.category = 'search';
  data.sites[0].slug = 'search';
  assert.deepEqual(check(data, legacy).errors, []);
});
test('纯函数不修改输入，重复调用结果一致；不注入本地图标时执行结构校验', () => {
  const { data, legacy } = fixture();
  const before = JSON.stringify({ data, legacy });
  const freeze = (value) => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  };
  freeze(data);
  freeze(legacy);
  assert.deepEqual(validateNavigationData(data, legacy), validateNavigationData(data, legacy));
  assert.equal(validateNavigationData(data, legacy).valid, true);
  assert.equal(JSON.stringify({ data, legacy }), before);
});

for (const icon of [null, { type: 'iconify', value: 'lucide:sparkles' }, { type: 'iconify', value: 'lucide:sparkle' },
  { type: 'url', value: 'https://images.example.com/图标.png' }, { type: 'raw', value: '&#xe645;' }]) {
  test(`接受实际支持的图标：${JSON.stringify(icon)}`, () => {
    const { data, legacy } = fixture();
    data.sites[0].icon = icon;
    assert.deepEqual(check(data, legacy).errors, []);
  });
}

test('一个统一站点可以合并两个不同的旧精选 recordId', () => {
  const { data, legacy } = fixture();
  legacy.categories[1].sites.push({ slug: 'same-site', url: 'http://example.com/?utm_source=old' });
  data.sites[0].sources.push({ dataset: 'sites.json', recordId: 'tools/same-site', originalUrl: 'http://example.com/' });
  data.sites[0].tags.push('多来源合并');
  Object.assign(data.meta.stats, { sourceRecords: 3, parsedValidRecords: 3, duplicateRecordsMerged: 1, duplicateGroups: 1 });
  data.meta.sources[0].recordCount = 3;
  const report = check(data, legacy);
  assert.deepEqual(report.errors, []);
  assert.equal(report.stats.legacyMatched, 3);
  assert.equal(report.stats.sites, 2);
});

test('sources 自身去重后条数可少于 parsedValidRecords，合并组按原有标签统计', () => {
  const { data, legacy } = fixture();
  Object.assign(data.meta.stats, { sourceRecords: 3, parsedValidRecords: 3, duplicateRecordsMerged: 1, duplicateGroups: 1 });
  data.meta.sources.push({ file: 'example.csv', recordCount: 1 });
  data.sites[0].tags.push('多来源合并');
  assert.deepEqual(check(data, legacy).errors, []);
});

test('来源身份通过 alternateUrls 对应时不会误判旧精选丢失', () => {
  const { data, legacy } = fixture();
  data.sites[0].alternateUrls.push(data.sites[0].url);
  data.sites[0].url = 'https://new.example.com/';
  assert.deepEqual(check(data, legacy).errors, []);
});

test('规范化忽略协议、www、大小写域名、尾斜杠、锚点、推广参数及查询键顺序', () => {
  const left = normalizeUrl('HTTP://WWW.Example.COM:80/path/?b=2&utm_source=x&a=1&REF=x&from=y&inviter=z#section');
  const right = normalizeUrl('https://example.com/path?a=1&b=2');
  assert.equal(left, right);
  assert.equal(normalizeUrl('https://example.com'), normalizeUrl('http://www.example.com/'));
});

test('规范化保留不同工具的路径、业务参数、重复查询参数和非默认端口', () => {
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/a?q=1',
    'https://example.com/a?q=2', 'https://example.com/a?q=1&q=2', 'https://example.com:8443/a'];
  assert.equal(new Set(urls.map(normalizeUrl)).size, urls.length);
});

for (const value of ['', 'example.com', '//example.com', 'https:example.com', 'ftp://example.com',
  'javascript:alert(1)', 'https://', 'https:///example.com', 'https:////example.com', 'https://example.com/a b', 'https://example.com/\n', 'https://example.com\\path', null]) {
  test(`拒绝非法主 URL：${JSON.stringify(value)}`, () => {
    const { data, legacy } = fixture();
    data.sites[0].url = value;
    assert.equal(check(data, legacy).valid, false);
    assert.match(check(data, legacy).errors.join('\n'), /sites\[0\]\.url.*HTTP\(S\)/);
    assert.throws(() => normalizeUrl(value));
  });
}

for (const reserved of RESERVED_ROUTES) {
  rejectsChange(`拒绝分类占用保留静态路由：${reserved}`, (data) => { data.categories[0].slug = reserved; }, /保留静态路由/);
}
for (const slug of ['../escape', 'a/b', 'a%2fb', 'a?tab=x', 'a#hash', '中文', '', '-bad', 'bad-', 'a--b', 'Upper', 'a_b']) {
  rejectsChange(`拒绝不安全站点 slug：${JSON.stringify(slug)}`, (data) => { data.sites[0].slug = slug; }, /slug 不安全/);
}

const badCases = [
  ['重复分类 ID', (d) => { d.categories[1].id = d.categories[0].id; }, /categories\[1\]\.id.*重复/],
  ['重复分类 slug', (d) => { d.categories[1].slug = d.categories[0].slug; }, /categories\[1\]\.slug.*重复/],
  ['空分类名称', (d) => { d.categories[0].name = '  '; }, /categories\[0\]\.name.*非空/],
  ['缺少站点 ID', (d) => { delete d.sites[0].id; }, /sites\[0\]\.id.*非空/],
  ['重复站点 ID', (d) => { d.sites[1].id = d.sites[0].id; }, /sites\[1\]\.id.*重复/],
  ['分类内重复 slug', (d) => { d.sites[1].category = 'ai'; }, /分类 ai 内 slug 重复/],
  ['未知分类引用', (d) => { d.sites[0].category = 'missing'; }, /引用不存在的分类/],
  ['空站点名称', (d) => { d.sites[0].name = '\t '; }, /sites\[0\]\.name.*非空/],
  ['非字符串站点名称', (d) => { d.sites[0].name = 12; }, /sites\[0\]\.name.*非空/],
  ['非法备用 URL', (d) => { d.sites[0].alternateUrls = ['data:text/plain,no']; }, /alternateUrls.*HTTP\(S\)/],
  ['未知图标类型', (d) => { d.sites[0].icon = { type: 'svg', value: '<svg/>' }; }, /仅支持 iconify、url、raw/],
  ['图标缺失', (d) => { delete d.sites[0].icon; }, /null 或图标对象/],
  ['图标不是对象', (d) => { d.sites[0].icon = 'lucide:sparkles'; }, /null 或图标对象/],
  ['图标值为空', (d) => { d.sites[0].icon = { type: 'raw', value: ' ' }; }, /icon\.value.*非空/],
  ['图标值不是字符串', (d) => { d.sites[0].icon = { type: 'raw', value: {} }; }, /icon\.value.*非空/],
  ['图标图片 URL 非法', (d) => { d.sites[0].icon = { type: 'url', value: '/image.png' }; }, /icon\.value.*HTTP\(S\)/],
  ['Iconify 名称格式错误', (d) => { d.sites[1].icon.value = 'invalid'; }, /prefix:name/],
  ['Iconify 名称不存在', (d) => { d.sites[1].icon.value = 'lucide:missing'; }, /本地图标集合中不存在/],
  ['Iconify 集合未安装', (d) => { d.sites[1].icon.value = 'missing:sparkles'; }, /本地图标集合中不存在/],
  ['分类 Iconify 不存在', (d) => { d.categories[0].icon = 'lucide:missing'; }, /本地图标集合中不存在/],
  ['图标 color 非字符串', (d) => { d.sites[1].icon.color = 123; }, /icon\.color.*非空/],
  ['规范化 URL 重复', (d) => { d.sites[1].url = 'http://example.com/?utm_campaign=x#hash'; }, /规范化 URL 重复/],
  ['分类计数错误', (d) => { d.categories[0].count = 9; }, /categories\[0\]\.count.*统计不一致/],
  ['分类计数不是整数', (d) => { d.categories[0].count = '1'; }, /非负安全整数/],
  ['分类计数为负数', (d) => { d.categories[0].count = -1; }, /非负安全整数/],
  ['meta 总站点数错误', (d) => { d.meta.stats.uniqueSites = 3; }, /meta.stats.uniqueSites.*统计不一致/],
  ['meta 分类总数错误', (d) => { d.meta.stats.categories = 3; }, /meta.stats.categories.*统计不一致/],
  ['meta 原始记录恒等式错误', (d) => { d.meta.stats.sourceRecords++; }, /meta.stats.sourceRecords.*统计不一致/],
  ['meta 成功解析恒等式错误', (d) => { d.meta.stats.parsedValidRecords++; }, /meta.stats.parsedValidRecords.*统计不一致/],
  ['meta 合并记录数错误', (d) => { d.meta.stats.duplicateRecordsMerged++; }, /meta.stats.parsedValidRecords.*统计不一致/],
  ['meta 合并组数错误', (d) => { d.meta.stats.duplicateGroups++; }, /meta.stats.duplicateGroups.*统计不一致/],
  ['meta 排除明细不匹配', (d) => { d.meta.exclusions.push({ source: 'sites.json' }); }, /meta.stats.excludedRecords.*统计不一致/],
  ['meta 来源总数错误', (d) => { d.meta.sources[0].recordCount++; }, /meta.sources 记录总数.*统计不一致/],
  ['meta 来源重复声明', (d) => { d.meta.sources.push({ ...d.meta.sources[0] }); }, /meta.sources\[1\].file.*重复/],
  ['meta 排除明细来源未知', (d) => { d.meta.exclusions.push({ source: 'missing.csv' }); }, /必须引用已声明的数据来源/],
  ['meta 历史重分类数越界', (d) => { d.meta.stats.reclassified = 3; }, /不能超过站点总数/],
  ['meta 低置信度数不匹配', (d) => { d.meta.stats.lowConfidence = 1; }, /meta.stats.lowConfidence.*统计不一致/],
  ['分类判定字段不一致', (d) => { d.sites[0].classification.category = 'tools'; }, /classification.category.*统计不一致/],
  ['缺少验证状态', (d) => { delete d.sites[0].verification; }, /unverified 是合法状态/],
  ['未声明来源', (d) => { d.sites[0].sources[0].dataset = 'missing.csv'; }, /未在 meta.sources 声明来源/],
  ['缺少来源记录', (d) => { d.sites[0].sources = []; }, /至少保留一条来源记录/],
  ['来源 recordId 非字符串', (d) => { d.sites[0].sources[0].recordId = 42; }, /recordId.*非空/],
  ['旧精选 recordId 丢失', (d) => { d.sites[0].sources[0].recordId = 'chat'; }, /缺少.*recordId='ai\/chat'/],
  ['旧精选记录对应多个统一站点', (d) => { d.sites[1].sources.push({ ...d.sites[0].sources[0] }); }, /旧精选记录 ai\/chat 对应多个统一站点/],
  ['旧精选来源原网址错误', (d) => { d.sites[0].sources[0].originalUrl = 'https://wrong.example.com'; }, /来源网址或统一站点网址不匹配/],
  ['旧精选挂到无关站点', (d) => { d.sites[0].url = 'https://wrong.example.com'; }, /来源网址或统一站点网址不匹配/],
  ['源记录数超过声明量', (d) => { d.sites[0].sources.push({ dataset: 'sites.json', recordId: 'extra', originalUrl: d.sites[0].url }); }, /超过原始记录数/],
  ['meta 结构损坏', (d) => { d.meta = null; }, /meta.stats.*统计对象/],
  ['categories 不是数组', (d) => { d.categories = {}; }, /categories.*必须为数组/],
  ['sites 不是数组', (d) => { d.sites = null; }, /sites.*必须为数组/],
  ['站点数组包含 null', (d) => { d.sites[0] = null; }, /sites\[0\].*必须为对象/],
  ['分类数组包含 null', (d) => { d.categories[0] = null; }, /categories\[0\].*必须为对象/],
  ['来源数组包含 null', (d) => { d.sites[0].sources[0] = null; }, /sources\[0\].*必须为对象/],
];
for (const [name, mutate, expected] of badCases) rejectsChange(`拒绝${name}`, mutate, expected);

test('拒绝损坏的根节点及遗漏旧数据，不抛出意外异常', () => {
  for (const value of [null, [], 123, '数据', undefined]) {
    assert.equal(validateNavigationData(value, fixture().legacy).valid, false);
  }
  assert.match(validateNavigationData(fixture().data).errors.join('\n'), /必须提供旧精选数据/);
});

test('真实统一数据：全部 2400 个站点、18 个分类、70 条旧精选均保留', async () => {
  const data = JSON.parse(await readFile(new URL('../src/data/导航数据.json', import.meta.url), 'utf8'));
  const legacy = JSON.parse(await readFile(new URL('../src/data/sites.json', import.meta.url), 'utf8'));
  const collections = {};
  for (const prefix of ['lucide', 'simple-icons']) {
    collections[prefix] = JSON.parse(await readFile(new URL(`../node_modules/@iconify-json/${prefix}/icons.json`, import.meta.url), 'utf8'));
  }
  const report = validateNavigationData(data, legacy, { iconifyCollections: collections });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.stats, { categories: 18, sites: 2400, unverified: 2400, legacySites: 70, legacyMatched: 70 });
  const icons = data.sites.reduce((counts, site) => {
    const type = site.icon?.type ?? 'null';
    counts[type] = (counts[type] ?? 0) + 1;
    return counts;
  }, {});
  assert.deepEqual(icons, { null: 1875, url: 496, raw: 1, iconify: 28 });
  const bilibili = data.sites.find((site) => site.sources.some((source) => source.dataset === 'sites.json' && source.recordId === 'learn/bilibili'));
  assert.deepEqual(bilibili.sources.filter((source) => source.dataset === 'sites.json').map((source) => source.recordId).sort(), ['entertainment/bilibili-fun', 'learn/bilibili']);
  const reduced = { ...data, sites: data.sites.slice(1) };
  const reducedReport = validateNavigationData(reduced, legacy);
  assert.equal(reducedReport.valid, false);
  assert.match(reducedReport.errors.join('\n'), /meta.stats.uniqueSites.*统计不一致/);
});

test('命令行从任意工作目录运行，成功返回 0 并报告中文全量统计', () => {
  const child = spawnSync(process.execPath, [script], { cwd: tmpdir(), encoding: 'utf8' });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /18 个分类，2400 个站点/);
  assert.match(child.stdout, /unverified.*2400/);
  assert.match(child.stdout, /70\/70/);
  assert.match(child.stdout, /校验通过/);
});

test('命令行对坏数据、非法 JSON、缺失文件均返回非 0', async (t) => {
  const tempRoot = tmpdir();
  const directory = await mkdtemp(join(tempRoot, 'nav-validation-'));
  try {
    await mkdir(join(directory, 'scripts'), { recursive: true });
    await mkdir(join(directory, 'src', 'data'), { recursive: true });
    await mkdir(join(directory, 'node_modules', '@iconify-json', 'lucide'), { recursive: true });
    const temporaryScript = join(directory, 'scripts', '校验导航数据.mjs');
    await copyFile(script, temporaryScript);
    await writeFile(join(directory, 'node_modules', '@iconify-json', 'lucide', 'icons.json'), JSON.stringify(localIcons.lucide));
    const { data, legacy } = fixture();
    await writeFile(join(directory, 'src', 'data', 'sites.json'), JSON.stringify(legacy));
    for (const [name, content] of [
      ['错误分类计数', JSON.stringify({ ...data, categories: data.categories.map((category) => ({ ...category, count: 99 })) })],
      ['非法 JSON', '{'],
      ['根节点为空', 'null'],
      ['文件缺失', null],
    ]) {
      await t.test(name, async () => {
        const dataPath = join(directory, 'src', 'data', '导航数据.json');
        if (content === null) await rm(dataPath);
        else await writeFile(dataPath, content);
        const child = spawnSync(process.execPath, [temporaryScript], { encoding: 'utf8' });
        assert.ifError(child.error);
        assert.equal(child.status, 1);
        assert.match(child.stderr, /导航数据校验失败/);
      });
    }
  } finally {
    // 仅清理由本测试创建、且确认位于系统临时目录下的专用目录。
    const withinTemp = relative(tempRoot, directory);
    assert.ok(withinTemp && !withinTemp.startsWith('..') && !isAbsolute(withinTemp));
    await rm(directory, { recursive: true, force: true });
  }
});

rejectsChange('拒绝缺少描述字段', (data) => { delete data.sites[0].description; }, /description/);
rejectsChange('拒绝缺少域名字段', (data) => { delete data.sites[0].domain; }, /domain/);
rejectsChange('拒绝别名不是数组', (data) => { data.sites[0].aliases = null; }, /aliases/);
rejectsChange('拒绝别名包含非文本', (data) => { data.sites[0].aliases = [42]; }, /aliases/);
rejectsChange('拒绝原始分类不是数组', (data) => { data.sites[0].sourceCategories = null; }, /sourceCategories/);
rejectsChange('拒绝原始分类包含非文本', (data) => { data.sites[0].sourceCategories = [42]; }, /sourceCategories/);
rejectsChange('拒绝缺失分类排序', (data) => { delete data.categories[0].order; }, /order/);
rejectsChange('拒绝无效分类颜色', (data) => { data.categories[0].color = 'red'; }, /color/);
