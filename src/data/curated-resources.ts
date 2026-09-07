/** 仅核对官方公开资料；不代表功能实测、可用性或安全保证。详见 docs/精选导航来源.md。 */
export interface CuratedResource {
  id: string;
  name: string;
  url: string;
  description: string;
  useCase: string;
  sourceUrl: string;
  sourceTitle: string;
  checkedAt: string;
}

export interface ResourceGroup {
  id: string;
  label: string;
  icon: string;
  description: string;
  resources: CuratedResource[];
}

export const RESOURCE_GROUPS: ResourceGroup[] = [
  {
    "id": "ai-work",
    "label": "AI 效率",
    "icon": "lucide:sparkles",
    "description": "围绕问答、写作、资料整理与办公任务使用 AI。",
    "resources": [
      {
        "id": "claude",
        "name": "Claude",
        "url": "https://claude.ai/",
        "description": "支持内容写作、代码生成与联网搜索的 AI 助手。",
        "useCase": "起草文案、讨论代码与检索资料。",
        "sourceUrl": "https://claude.com/",
        "sourceTitle": "Claude",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "deepseek",
        "name": "DeepSeek",
        "url": "https://chat.deepseek.com/",
        "description": "提供网页对话与模型 API 入口。",
        "useCase": "围绕问题进行对话，或查找模型接入入口。",
        "sourceUrl": "https://www.deepseek.com/",
        "sourceTitle": "DeepSeek | 深度求索",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "doubao",
        "name": "豆包",
        "url": "https://www.doubao.com/chat/",
        "description": "支持对话问答、写作、翻译与编程辅助。",
        "useCase": "日常答疑、文案起草与文本翻译。",
        "sourceUrl": "https://www.doubao.com/chat/",
        "sourceTitle": "豆包 - 字节跳动旗下 AI 智能助手",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "kimi",
        "name": "Kimi",
        "url": "https://www.kimi.com/",
        "description": "提供对话、深度研究、文档与演示文稿任务入口。",
        "useCase": "整理研究任务、制作文档与演示文稿。",
        "sourceUrl": "https://www.kimi.com/",
        "sourceTitle": "Kimi AI 官网 - K3 上线，专为智能体编程与知识工作打造",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "copilot",
        "name": "Microsoft 365 Copilot",
        "url": "https://www.microsoft.com/en-us/microsoft-365-copilot/personal",
        "description": "在办公应用中辅助写作、数据分析与演示文稿制作。",
        "useCase": "起草文档、分析表格与梳理邮件内容。",
        "sourceUrl": "https://www.microsoft.com/en-us/microsoft-365-copilot/personal",
        "sourceTitle": "Microsoft 365 Copilot Plans for Individuals | Microsoft 365",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "qwen",
        "name": "Qwen",
        "url": "https://qwen.ai/",
        "description": "提供对话、文档处理、图像理解与联网搜索能力。",
        "useCase": "处理文档、理解图片与检索信息。",
        "sourceUrl": "https://qwen.ai/",
        "sourceTitle": "Qwen",
        "checkedAt": "2026-09-07"
      }
    ]
  },
  {
    "id": "creative",
    "label": "创作设计",
    "icon": "lucide:palette",
    "description": "从界面原型、图像视频到白板表达组织创作任务。",
    "resources": [
      {
        "id": "figma",
        "name": "Figma",
        "url": "https://www.figma.com/",
        "description": "用于界面设计、原型制作与协作的设计平台。",
        "useCase": "设计网页界面、制作交互原型与协作评审。",
        "sourceUrl": "https://www.figma.com/design/",
        "sourceTitle": "Free Design Tool for Websites, Product Design & More | Figma",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "canva",
        "name": "Canva",
        "url": "https://www.canva.com/",
        "description": "提供设计编辑器，并通过应用扩展内容导入与设计工作流。",
        "useCase": "编辑视觉内容，借助应用处理设计素材。",
        "sourceUrl": "https://www.canva.dev/docs/apps/",
        "sourceTitle": "Apps SDK documentation - Canva Apps SDK Documentation",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "jimeng",
        "name": "即梦",
        "url": "https://jimeng.jianying.com/",
        "description": "支持图像生成、视频生成与智能画布编辑。",
        "useCase": "制作图像与视频片段，调整画面元素。",
        "sourceUrl": "https://jimeng.jianying.com/",
        "sourceTitle": "即梦AI - 即刻造梦",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "firefly",
        "name": "Adobe Firefly",
        "url": "https://www.adobe.com/products/firefly.html",
        "description": "通过生成式 AI 创建和编辑图像、视频与音频。",
        "useCase": "探索画面创意、生成素材与修改视听内容。",
        "sourceUrl": "https://www.adobe.com/products/firefly.html",
        "sourceTitle": "Adobe Firefly - Free Generative AI for Creatives",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "excalidraw",
        "name": "Excalidraw",
        "url": "https://excalidraw.com/",
        "description": "用于绘制手绘风格图示的虚拟白板。",
        "useCase": "画流程示意、梳理思路与协作讨论。",
        "sourceUrl": "https://github.com/excalidraw/excalidraw",
        "sourceTitle": "GitHub - excalidraw/excalidraw: Virtual whiteboard for sketching hand-drawn like diagrams · GitHub",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "penpot",
        "name": "Penpot",
        "url": "https://penpot.app/",
        "description": "支持界面设计、交互原型与设计开发协作。",
        "useCase": "制作线框与原型，向开发人员交付设计。",
        "sourceUrl": "https://penpot.app/",
        "sourceTitle": "Penpot: The open-source design platform for teams.",
        "checkedAt": "2026-09-07"
      }
    ]
  },
  {
    "id": "dev-learn",
    "label": "开发学习",
    "icon": "lucide:code-xml",
    "description": "围绕代码协作、编辑、文档查阅与项目练习学习开发。",
    "resources": [
      {
        "id": "github",
        "name": "GitHub",
        "url": "https://github.com/",
        "description": "提供代码仓库、议题跟踪与代码评审等协作能力。",
        "useCase": "管理项目代码、参与开源与协作评审。",
        "sourceUrl": "https://github.com/",
        "sourceTitle": "GitHub · Change is constant. GitHub keeps you ahead. · GitHub",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "vscode",
        "name": "VS Code",
        "url": "https://code.visualstudio.com/",
        "description": "支持代码编辑、调试与扩展的开发工具。",
        "useCase": "编写项目代码、调试程序与配置开发环境。",
        "sourceUrl": "https://code.visualstudio.com/",
        "sourceTitle": "Visual Studio Code - The open source AI code editor | Your home for multi-agent development",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "mdn",
        "name": "MDN Web Docs",
        "url": "https://developer.mozilla.org/en-US/",
        "description": "提供 HTML、CSS、JavaScript 与 Web API 文档。",
        "useCase": "查阅 Web 技术用法与学习前端基础。",
        "sourceUrl": "https://developer.mozilla.org/en-US/",
        "sourceTitle": "MDN Web Docs",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "freecodecamp",
        "name": "freeCodeCamp",
        "url": "https://www.freecodecamp.org/",
        "description": "通过课程与项目实践学习编程的社区。",
        "useCase": "按步骤完成编程练习与项目。",
        "sourceUrl": "https://www.freecodecamp.org/news/about/",
        "sourceTitle": "About freeCodeCamp - Frequently Asked Questions",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "typescript",
        "name": "TypeScript",
        "url": "https://www.typescriptlang.org/",
        "description": "提供 TypeScript 文档、手册与在线 Playground。",
        "useCase": "学习类型语法，在浏览器中试验代码。",
        "sourceUrl": "https://www.typescriptlang.org/",
        "sourceTitle": "TypeScript: JavaScript With Syntax For Types.",
        "checkedAt": "2026-09-07"
      },
      {
        "id": "nodejs",
        "name": "Node.js",
        "url": "https://nodejs.org/en/",
        "description": "提供 JavaScript 运行时、学习资料与 API 文档入口。",
        "useCase": "学习服务端 JavaScript，编写脚本与命令行工具。",
        "sourceUrl": "https://nodejs.org/en/",
        "sourceTitle": "Node.js — Run JavaScript Everywhere",
        "checkedAt": "2026-09-07"
      }
    ]
  }
];
