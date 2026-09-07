import type { APIRoute } from 'astro';
import { getNavigation } from '../lib/data';
import { PAGE_SIZE } from '../lib/pagination';

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
  const { site: SITE } = await locals.getRuntimeSettings();
  const { categories } = await getNavigation();
  const entries: { loc: string; priority: string }[] = [
    { loc: `${SITE.url}/`, priority: '1.0' },
    { loc: `${SITE.url}/categories/`, priority: '0.7' },
    { loc: `${SITE.url}/tags/`, priority: '0.7' },
    { loc: `${SITE.url}/discover/`, priority: '0.8' },
  ];

  for (const cat of categories) {
    entries.push({ loc: `${SITE.url}/${cat.slug}/`, priority: '0.8' });
    for (let page = 2; page <= Math.ceil(cat.sites.length / PAGE_SIZE); page++) {
      entries.push({ loc: `${SITE.url}/${cat.slug}/page/${page}/`, priority: '0.7' });
    }
    for (const site of cat.sites) {
      entries.push({ loc: `${SITE.url}/${cat.slug}/${site.slug}/`, priority: '0.6' });
    }
  }

  // 数据模型没有可靠的逐页更新时间，省略可选 lastmod，避免伪造更新信号。
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${e.loc.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</loc>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
