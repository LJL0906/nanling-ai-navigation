# 上线前SEO优化与验收

验收日期：2026-09-07。

## 本次完成

- 保留现有 SSR、页面标题、描述、canonical、Open Graph、Twitter Card 和 JSON-LD；补齐分享图片替代文本及 HTTP `X-Robots-Tag`，页面与响应头索引策略一致。
- 普通分类分页独立 canonical；含 `sub` 的筛选页面（包括空值、无效值和 `all`）禁止索引，canonical 归分类首页。跟踪参数不进入 canonical。
- 分类卡片主入口仍直达目标网站，右侧入口提供可抓取详情链接；收藏按钮保持独立。同类推荐同时保留官网卡片及详情链接。
- 详情展示真实描述、分类、网址、别名和标签，结构化数据与页面内容对应。同名站点用真实域名区分，同域不同入口再用路径区分；未核验条目展示提示，不编造评分、价格、功能或使用体验。
- 成功的无尾斜线 HTML GET/HEAD 请求 301 至尾斜线地址，保留查询参数；不把不存在页面重定向成正常页面，不改变 API、静态资源和 POST 语义。
- 404/错误响应、JSON 索引、后台与账号页面禁止索引；通知和设置保留原有 302 入口，并补齐禁止索引响应头。
- sitemap 保留正式域名下的首页、分类目录、标签目录、精选目录、分类分页和全部详情；不包含搜索、个人页面、后台或筛选参数。
- 删除固定的全站 `lastmod` 和没有事实依据的固定 `changefreq`。当前数据模型没有可靠的逐页修改时间，暂不输出可选更新时间，未来有真实数据后再接入。

## 可重复验收

```bash
npm test
npm run typecheck
npm run build
npm run test:build
npm run test:seo
npm run test:seo -- --all
```

`test:seo` 默认检查全部分类分页、每类一个详情和主要公共页面，同时检查 sitemap 全量覆盖与详情内链发现；`--all` 对 sitemap 全部页面逐一检查。

SEO 与生产回归脚本在随机本地端口启动 Node 生产服务，强制使用只读 seed 数据，不加载 `.env`，不写数据库、不提交站长平台、不访问第三方站点。

多人同时构建时可隔离产物，避免运行中的服务引用被另一轮构建替换的 chunk（PowerShell）：

```powershell
npm run build -- --outDir .astro/seo-dist
$env:NAV_BUILD_DIR = '.astro/seo-dist'
npm run test:build
npm run test:seo -- --all
Remove-Item Env:NAV_BUILD_DIR
```

## 验收结果

- 数据与生产构建：通过。
- 类型检查：0 errors、0 warnings；2 条范围外提示。
- 最近一次全量测试：880 项通过，0 失败。Windows 环境未授权符号链接时，既有测试会跳过链接断言，不代表该边界已实测。
- SEO 全量生产检查：2,462 个 URL 全部直接返回 200、自引用 canonical、标题不重复，具备唯一 H1、非空描述、可解析 JSON-LD，OG URL 与 canonical 一致，图片具有 alt。
- sitemap 全量覆盖 18 类、2,400 个详情；所有详情可通过服务端 HTML 链接发现。
- 搜索、账号、个人页面及占位栏目 noindex；通知/设置跳转、404、GET/HEAD 301 规范化和公开 JSON 索引隔离通过。
- 生产功能回归：18 分类、2,400 站点、44 条旧链接 301，首页 299 张卡片（含动态模板）、详情推荐、收藏、API 分页及管理鉴权通过。

## 上线后仍需做

- 用生产 MySQL 数据复查内容与 URL；本次 seed 验收不等同于生产数据库验收。
- 验证正式域名、HTTPS、反向代理与 CDN 没有错误重定向或覆盖索引响应头。
- 在实际采用的搜索站长平台验证所有权、提交 sitemap，观察抓取、索引与搜索表现。
- 用移动端实测性能和真实访问数据判断 Core Web Vitals；本次生产 HTML 检查不能代替真实用户性能数据。
- 分批人工核验站点与重点分类，补充有依据的原创介绍、适用场景和限制。当前不因 SEO 自动生成未经验证的工具测评，也不承诺收录或排名。

## 本次文件清单

新增：
- `scripts/检查SEO产物.mjs`
- `scripts/分类与详情SEO.test.mjs`
- `docs/上线前SEO优化与验收.md`

修改：
- `package.json`
- `README.md`
- `src/config/site.ts`
- `src/lib/seo.ts`
- `src/layouts/BaseLayout.astro`
- `src/middleware.ts`
- `src/pages/sitemap.xml.ts`
- `src/components/category/CategoryPage.astro`
- `src/pages/[category]/[slug].astro`

删除：无。构建会刷新忽略目录下的生成产物；不将其列为源码交付。其他已有或并行任务的工作区改动未计入本清单。
