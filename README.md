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

楠灵AI 导航是一个基于 Astro 构建的轻量级导航网站。它将搜索引擎、AI 工具、开发工具、设计素材、资讯社区等高频站点按场景整理，让用户可以更快找到真正有用的网站。

项目强调 **清晰的信息层级、快速的访问路径和舒适的浏览体验**，同时保留了收藏、历史记录、搜索、分类浏览等常用功能入口。

## 功能特性

- **分门别类的站点导航**：搜索引擎、AI、开发、设计、教育、社区等分类一目了然。
- **全局搜索**：支持按名称、描述和标签快速查找站点。
- **快捷入口**：提供热门搜索词和快搜导航，减少重复输入。
- **收藏与历史**：在浏览器本地保存收藏站点和最近访问记录，无需登录。
- **响应式布局**：适配桌面端与移动端浏览。
- **主题切换**：支持明暗主题，自动记住用户偏好。
- **SEO 友好**：内置页面标题、描述、关键词、canonical、Open Graph、JSON-LD 和 sitemap。
- **数据驱动**：站点数据集中维护，便于持续补充和更新。

## 技术栈

- [Astro](https://astro.build/) 5
- [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS](https://tailwindcss.com/) 4
- [astro-icon](https://github.com/natemoo-re/astro-icon)
- Lucide / Simple Icons

## 快速开始

### 环境要求

- Node.js 18.17 或更高版本
- npm 9 或更高版本

### 安装与运行

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

开发服务器默认地址为 `http://localhost:4321`。

### 构建与预览

```bash
# 生产构建
npm run build

# 本地预览生产构建
npm run preview

# 类型检查
npm run typecheck
```

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

常用站点数据位于 `src/data/`。更新 JSON / CSV 数据后，重新运行构建即可检查数据和页面是否正常：

```bash
npm run build
```

如果需要从一流导航同步数据，可以运行：

```bash
npm run scrape:yiliudz
```

运行抓取脚本前，请先阅读 `src/data/README_getUrl.md`，确认数据来源和字段格式。

## 部署

项目可以部署到任何支持静态站点的托管平台，例如 GitHub Pages、Vercel、Netlify 或 Cloudflare Pages。生产构建产物位于 `dist/` 目录。

## 开源协议

本项目代码采用 MIT License。站点数据及第三方品牌图标请遵循各自的授权与使用条款。

---

<p align="center">如果这个项目对你有帮助，欢迎点一个 ⭐</p>


