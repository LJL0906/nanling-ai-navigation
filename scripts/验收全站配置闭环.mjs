/** 真实 MySQL 联调：仅保存当前同值配置，不修改站点、用户、菜单或配置业务值。 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import mysql from 'mysql2/promise';
import { getMySqlOptions } from '../src/server/database-config.ts';
import { SITE_FIELDS, readStoredSiteSettings } from '../src/server/settings-validation.ts';
const base = process.env.NAV_TEST_BASE ?? 'http://localhost:4321';
assert.equal(process.env.NAV_STORAGE, 'mysql', '本脚本仅用于明确配置的MySQL环境');
assert.ok(process.env.ADMIN_TOKEN, '需要本地ADMIN_TOKEN；不会输出凭据');
const headers = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
const results = [];
const request = (path, init = {}) => fetch(base + path, { redirect: 'manual', signal: AbortSignal.timeout(30000), ...init });
const check = (name, value) => { assert.ok(value, name); results.push({ name, passed: true }); };
const get = async () => {
  const response = await request('/api/admin/settings', { headers });
  assert.equal(response.status, 200);
  return (await response.json()).data;
};
const before = await get();
check('MySQL配置可读可写', before.writable === true);
check('匿名设置接口拒绝访问', (await request('/api/admin/settings')).status === 401);
check('后台设置页需要登录', (await request('/admin/settings/')).status === 302);
const command = { site: before.site, homeSectionPageSize: before.homeSectionPageSize, revision: before.revision };
const put = (value, origin = base) => request('/api/admin/settings', {
  method: 'PUT', headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(value),
});
check('跨站修改拒绝', (await put(command, 'https://invalid.example')).status === 403);
check('非法首页数量拒绝', (await put({ ...command, homeSectionPageSize: 0 })).status === 400);
check('错误版本冲突保护', (await put({ ...command, revision: '0'.repeat(64) })).status === 409);
const saved = await put(command);
assert.equal(saved.status, 200);
const returned = (await saved.json()).data;
const after = await get();
check('同值保存及接口回读一致', JSON.stringify(after) === JSON.stringify(returned) && after.revision === before.revision);
const connection = await mysql.createConnection(getMySqlOptions());
try {
  const [rows] = await connection.query('SELECT setting_key, payload FROM nav_settings WHERE setting_key IN (?, ?)', ['site', 'homeSectionPageSize']);
  const data = Object.fromEntries(rows.map(row => [row.setting_key, typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload]));
  assert.deepEqual(readStoredSiteSettings(data.site), before.site);
  check('数据库保存配置与接口一致', data.homeSectionPageSize === before.homeSectionPageSize);
} finally { await connection.end(); }
const html = await (await request('/')).text();
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
check('首页品牌及标题读取配置', html.includes(escape(after.site.name)) && html.includes(escape(after.site.heroTitle)));
check('首页数量传递客户端', html.includes(`data-home-page-size="${after.homeSectionPageSize}"`));
const sitemap = await (await request('/sitemap.xml')).text();
check('sitemap读取配置域名', sitemap.includes(`<loc>${after.site.url}/</loc>`));
for (const path of ['/articles/', '/quick-search/']) check(`${path}已删除并返回404`, (await request(path)).status === 404);
const tags = await (await request('/tags/')).text();
const tagLink = tags.match(/href="([^"\s]+\?sub=[^"\s]+)"/);
check('标签目录具有真实筛选链接', !!tagLink);
check('标签筛选目标可访问', (await request(tagLink[1].replaceAll('&amp;', '&'))).status === 200);
if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
  const response = await request('/api/admin/session', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD }) });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  try {
    const page = await request('/admin/settings/', { headers: { Cookie: cookie } });
    const body = await page.text();
    check('登录后设置表单与脚本可访问', page.status === 200 && body.includes('data-settings-form') && body.includes('data-settings-fields'));
    const current = await request('/api/admin/settings', { headers: { Cookie: cookie } });
    check('浏览器会话读取设置成功', current.status === 200);
    const missingOrigin = await request('/api/admin/settings', { method: 'PUT', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
    check('Cookie写请求必须携带同源Origin', missingOrigin.status === 403);
  } finally { await request('/api/admin/session', { method: 'DELETE', headers: { Cookie: cookie, Origin: base } }); }
}
const report = { checkedAt: new Date().toISOString(), base, mode: 'MySQL real API, same-value settings save only; no site/user/menu mutation', siteFields: SITE_FIELDS, results };
writeFileSync(new URL('../reports/闭环改造-MySQL联调.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(`配置真实MySQL闭环验收通过：${results.length}项；仅保存原业务值，无站点/用户/菜单变更。`);
