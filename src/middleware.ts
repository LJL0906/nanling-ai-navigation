import type { MiddlewareHandler } from 'astro';
import { getRuntimeSettings } from './server/settings-store.ts';
import { getAdminSession, safeAdminNext } from './server/admin-session.ts';

export const onRequest: MiddlewareHandler = async (context, next) => {
  // 每个请求首次消费时才读取，嵌套布局和并发组件共用 Promise。
  let runtimeSettings: ReturnType<typeof getRuntimeSettings> | undefined;
  context.locals.getRuntimeSettings = () => runtimeSettings ??= getRuntimeSettings();
  const path = context.url.pathname;
  const admin = /^\/admin(?:\/|$)/.test(path);
  const login = path === '/admin/login/' || path === '/admin/login';
  let response = admin && !login && !getAdminSession(context.request)
    ? context.redirect(`/admin/login/?next=${encodeURIComponent(safeAdminNext(path + context.url.search))}`, 302)
    : await next();
  // 只规范化已成功解析的 HTML 页面；API、静态文件、POST 和 404 保持原语义。
  if (['GET', 'HEAD'].includes(context.request.method) && response.status === 200
    && response.headers.get('Content-Type')?.includes('text/html') && !path.endsWith('/')) {
    // 使用站内绝对路径，避免双斜线被解释为外站重定向。
    response = context.redirect(path.replace(/^\/+/, '/') + '/' + context.url.search, 301);
  }
  if (response.status >= 400 || response.headers.get('Content-Type')?.includes('application/json')
    || /^\/(?:search-index|personal-sites|history-destinations)\.json$/.test(path)) {
    response.headers.set('X-Robots-Tag', 'noindex, follow');
  }
  // 嵌套页异步渲染可能晚于流式响应提交，在路由层保证筛选及个人页的索引策略。
  if (context.url.searchParams.has('sub') && /^\/[^/]+\/(?:page\/[^/]+\/)?$/.test(path)
    && response.headers.get('Content-Type')?.includes('text/html')) {
    response.headers.set('X-Robots-Tag', 'noindex, follow');
  }
  if (/^\/(?:favorites|history|search)(?:\/|$)/.test(path)) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, follow');
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set('X-Frame-Options', 'DENY');
  if (/^\/(?:admin|api|login|register|notifications|settings)(?:\/|$)/.test(path)) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }
  return response;
};

