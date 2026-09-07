# 楠灵AI 导航

> 发现优质，探索无限 —— 一个面向日常工作、学习与创作的现代化网站导航站。

<p align="center">
  <img src="./public/logo.png" width="72" alt="楠灵AI 导航 Logo" />
</p>

<p align="center">
  <strong>探索优质网站，发现无限可能</strong><br />
  精心整理的实用网站导航，助你高效获取信息
</p>

<p align="center">
  <a href="https://nav.ljianl.com">在线体验</a> ·
  <a href="https://github.com/LJL0906">作者主页</a>
</p>

<p align="center">
  <img src="./public/preview-card.svg" alt="楠灵AI 导航首页预览" width="960" />
</p>

## 项目简介

楠灵AI 导航是一个基于 Astro + Node 构建的全栈导航网站。它将搜索引擎、AI 工具、开发工具、设计素材、资讯社区等高频站点按场景整理，让用户可以更快找到真正有用的网站。

项目强调 **清晰的信息层级、快速的访问路径和舒适的浏览体验**，同时保留了收藏、历史记录、搜索、分类浏览等常用功能入口。

## 功能特性

- **分门别类的站点导航**：搜索引擎、AI、开发、设计、教育、社区等分类一目了然。
- **全局搜索**：支持按名称、描述和标签快速查找站点。
- **工具精选**：顶部精选与精选目录共用数据库菜单，支持后台新增、编辑、删除和显隐。
- **动态细分**：首页与分类页按实时站点标签及来源分类筛选，默认展示全部；已移除固定热搜。
- **消息通知**：右侧抽屉提供站点变动、我的提交、系统公告三类消息，私人提交按账号隔离。
- **收藏与历史**：登录后保存至 MySQL，同一账号跨设备读取；未登录操作打开居中登录/注册弹窗，提交站点也须登录，审核通知绑定提交账号。
- **响应式布局**：适配桌面端与移动端浏览。
- **主题切换**：支持明暗主题，自动记住用户偏好。
- **SEO 友好**：内置页面标题、描述、关键词、canonical、Open Graph、JSON-LD 和 sitemap。
- **数据驱动**：站点数据集中维护，便于持续补充和更新。

## 技术栈

- Astro 7 + Node standalone 服务端适配器
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/) 4
- [astro-icon](https://github.com/natemoo-re/astro-icon)
- Lucide / Simple Icons

## 全栈架构状态

页面与 API 已统一为服务端运行时读取。本地已切换 MySQL，完成 18 类、2400 条站点以及 52 条菜单、8 项配置的入库和回读验证；未配置 NAV_STORAGE 时仍默认使用种子仓储。菜单已完成管理页、鉴权读写接口、数据库与前台展示闭环；全站配置已接通 `/admin/settings/`、鉴权读写接口及前台运行时读取，保存后下一次加载生效。分类和站点已开放 MySQL 增删改，独立页面为 /admin/categories/ 和 /admin/sites/；包含关联删除保护、版本冲突校验、同源鉴权和保存后缓存失效。审核历史保持不可改写。点击设置进入 /admin/login/，使用服务端 ADMIN_USERNAME / ADMIN_PASSWORD 登录后进入 /admin/；菜单工作台为 /admin/menus/，提交审批与审核历史为 /admin/reviews/。管理员会话跨页面有效；原 ADMIN_TOKEN 保留用于 CLI 接口认证。审批通过在同一 MySQL 事务中发布导航卡片并保存审核记录，前台刷新后可见；发布失败回滚。配置与边界见 docs/管理员登录与审核说明.md。详见 docs/菜单接口与管理说明.md。

环境变量、API及部署详见 docs/全栈开发与部署.md；MySQL密码填写与初始化步骤见 docs/MySQL接入说明.md。不要提交真实令牌或数据库密码。

用户账号、居中登录注册弹窗、收藏与最近访问的数据闭环见 `docs/用户登录与个人数据闭环.md`；部署前执行 `npm run db:migrate-accounts -- --apply` 初始化用户相关表。

通知与提交归属部署前执行 `npm run db:migrate-notifications -- --apply`（增量迁移，不回填历史匿名归属）。公告后台为 `/admin/announcements/`；细分、精选与消息的实现及文件清单见 `docs/业务数据与通知改造交付.md`。

## 本轮页面清理与配置闭环

已删除文章和快搜占位页，标签目录改用真实动态细分；新增与审批发布站点的 ID 已统一兼容搜索、收藏和最近访问。全站配置仅管理真实生效的站点信息及首页每批数量，历史快照和用户身份不恢复为配置。接口、验证与文件清单见 `docs/页面清理与配置闭环交付.md`。

## 快速开始

### 环境要求

- Node.js 24（本次验证使用 v24.20.0；数据适配测试使用 Node 原生 TypeScript 支持）
- npm 9.6.5 或更高版本

### 安装与运行

```bash
# 安装依赖
npm install

# 首次使用时复制示例配置，已有 .env 不要覆盖
cp .env.example .env

# 启动开发服务器
npm run dev
```

开发服务器默认地址为 `http://localhost:4321`。

### 构建与预览

```bash
# 校验统一站点库（生产构建也会自动执行）
npm run validate:data

# 数据校验与适配测试
npm test

# 生产构建
npm run build

# 验证 Node 服务端产物
npm run test:build

# 生产启动
npm start

# 本地预览生产构建
npm run preview

# 类型检查
npm run typecheck
```

## 上线前 SEO 验收

完成生产构建后执行 `npm run test:seo`；全量检查 sitemap 页面执行 `npm run test:seo -- --all`。脚本使用只读种子数据启动本地生产服务，不写数据库。优化范围、验收结果和上线后检查项见 `docs/上线前SEO优化与验收.md`。

## 目录结构

```text
src/
├── components/      # 页面组件与通用 UI 组件
├── config/          # 站点信息、顶部导航和侧边栏配置
├── data/            # 导航站点数据（JSON / CSV）
├── layouts/         # 页面布局
├── lib/             # 数据处理、SEO 和类型定义
├── pages/           # Astro 页面与动态路由
├── scripts/         # 浏览器端交互脚本
└── styles/          # 全局样式
public/
├── logo.png         # 站点 Logo
└── site.webmanifest # PWA 元数据
```

## 添加或更新站点

页面内容统一读取 `src/data/导航数据.json`，目前接入 18 个分类、2400 条站点。
`src/lib/adapt-navigation.ts` 将统一字段转换为页面模型；`src/data/sites.json` 仅保留原有精选顺序、卡片视觉配置和旧路径映射，不再是全站内容源。

- 首页按分类分区与二级标签组织内容，完整数据也可通过分类、搜索及 API 访问。
- 分类页请求时渲染，每页 48 条；站内搜索通过本站运行时生成的索引匹配全部站点。
- 新数据应更新统一站点库及对应统计；修改原始 CSV 或采集快照不会自动更新页面。
- 所有站点目前仍为 `unverified`；数据校验不等于在线可用性或内容安全审核。

更新后执行：

```bash
npm run validate:data
npm test
npm run typecheck
npm run build
```


### 批量补充站点图标

使用 Python 3.10+（无需额外依赖）下载缺失图标到本地，保留已有品牌图标和有效缓存，不修改原始站点数据：

```bash
python -B scripts/补充站点图标.py --dry-run
python -B scripts/补充站点图标.py
```

运行后重新构建、部署即可展示本地图标；无法下载的站点保留首字兜底，错误详情见 `reports/站点图标补充报告.json`。参数、重试及离线测试见 `docs/站点图标补充说明.md`。
详细边界与维护说明见 `docs/数据接入记录.md`。
如果需要从一流导航同步数据，可以运行：

```bash
npm run scrape:yiliudz
```

运行抓取脚本前，请先阅读 `src/data/README_getUrl.md`，确认数据来源和字段格式。

## 部署

项目当前需要 Node 服务端运行环境。执行 `npm run build` 后，通过 `npm start` 启动 `dist/server/entry.mjs`，并保留 `dist/client/` 和生产依赖。不能只上传静态文件到 GitHub Pages。部署平台及数据库接入步骤见 `docs/全栈开发与部署.md`。

## 开源协议

本项目代码采用 MIT License。站点数据及第三方品牌图标请遵循各自的授权与使用条款。

---

<p align="center">如果这个项目对你有帮助，欢迎点一个 ⭐</p>

