import type { APIRoute } from 'astro';
import { SITE } from '../config/site';
import { categories } from '../lib/data';

export const GET: APIRoute = () => {
  const entries: { loc: string; priority: string }[] = [
    { loc: `${SITE.url}/`, priority: '1.0' },
    { loc: `${SITE.url}/categories/`, priority: '0.7' },
  ];

  for (const cat of categories) {
    entries.push({ loc: `${SITE.url}/${cat.slug}/`, priority: '0.8' });
    for (const site of cat.sites) {
      entries.push({ loc: `${SITE.url}/${cat.slug}/${site.slug}/`, priority: '0.6' });
    }
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries
  .map(
    (e) => `  <url>
    <loc>${e.loc}</loc>
    <lastmod>${SITE.lastmod}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>${e.priority}</priority>
  </url>`
  )
  .join('\n')}
</urlset>
`;

  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
