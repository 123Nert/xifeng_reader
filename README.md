# xifeng 阅读

[![version](https://img.shields.io/github/v/tag/123Nert/xifeng_reader?label=version)](https://github.com/123Nert/xifeng_reader/tags)
[![tests](https://img.shields.io/badge/tests-148%20passing-brightgreen)](src)
[![PWA](https://img.shields.io/badge/PWA-ready-blueviolet)](vite.config.ts)

本地电子书阅读器（Web 应用）。核心闭环：**导入一本书 → 舒服地读完 → 下次打开接着读**。

产品设计见 [docs/产品设计文档.md](docs/产品设计文档.md)，技术方案见 [docs/技术方案.md](docs/技术方案.md)，迭代规划见 [docs/功能迭代计划.md](docs/功能迭代计划.md)。

## 功能

- 导入 **TXT / EPUB / Markdown / HTML / PDF**（多选批量导入，拖拽即可）
- TXT 自动识别 UTF-8 / GB18030（含 GBK）/ Big5 / UTF-16，可手动指定编码
- EPUB 解析真实章节与目录、提取封面与作者（零依赖自研解析，见 [V5.0 方案](docs/V5.0-多格式导入方案.md)）
- PDF 抽文本阅读（V6.0；pdf.js 按需加载、不画图，章节识别优先 + 页码兜底，见 [V6.0 方案](docs/V6.0-PDF支持方案.md)）
- 书库：书名、阅读进度、最后阅读时间、搜索/排序/重命名/批量删除、阅读时长统计（今日/本周/累计）
- 阅读页：分页 / 连续滚动两种模式；按钮 / 键盘 / 点按区域翻页；自动翻页；TTS 朗读（读完自动翻页）
- 排版：字号、行距、段距、页边距、首行缩进、两端对齐、字体预设与自定义字体
- 主题：日间 / 护眼 / 夜间
- 导航：章节目录（内置 + 自定义正则）、书签、全文搜索（页面内高亮）、划线笔记（可导出 Markdown，见 [V4.0 方案](docs/V4.0-批注与笔记方案.md)）
- 进度自动保存，重新打开精确续读；进度条拖动跳转任意位置
- PWA 可安装，离线可读；备份导出 / 导入（全量 JSON）

## 当前版本

**V6.0 PDF 支持** ✅

按字符偏移把 PDF 抽成单文本流，与 EPUB/TXT 共用同一套分页/批注/搜索/TTS 管线；
pdf.js 按需动态加载，普通用户体积零增加；扫描版给"建议 OCR"提示，加密版要求先解密。
完整设计与验收见 [docs/V6.0-PDF支持方案.md](docs/V6.0-PDF支持方案.md)。

历史版本：

| 版本 | 主题 | 标记 |
| --- | --- | --- |
| v6.0.0 | PDF 支持（pdf.js 按需加载） | ✅ 当前 |
| v5.0.0 | 多格式导入（EPUB / MD / HTML + 批量） | ✅ |
| v4.0.0 | 批注与笔记体系（6 色 × 4 样式 + 容错锚定） | ✅ |
| v3.0.0 | 划线笔记 MVP + TTS 朗读 | ✅ |
| v2.1.0 | PWA 可安装 + 滚动阅读 | ✅ |
| v2.0.0 | 书库管理 + 阅读统计 + 备份导出 | ✅ |
| v1.1–v1.3 | 主题 / 章节切分 / 排版净化 | ✅ |
| v1.0 | MVP（导入 → 阅读 → 续读） | ✅ |

## 运行

需要 Node ≥ 20。

```bash
npm install
npm run dev        # 开发（http://localhost:5173）
npm run test       # Vitest 单元测试（148 例）
npm run build      # 产出纯静态文件到 dist/
npm run preview    # 本地预览构建产物
```

首次跑 `dev` / `build` / `test` 前，会自动执行 `npm run sync:pdfjs` 把
`node_modules/pdfjs-dist/{cmaps,standard_fonts}` 铺到 `public/pdfjs/`，
保证中文 PDF（Type0 + 预定义 CMap）能在浏览器里被解出文字。

> 注意：IndexedDB 在 `file://` 协议下不可用，请通过 http(s) / localhost 访问，不要直接双击打开 HTML。

## 结构

```
src/
├─ main.tsx / App.tsx        # 入口；书库 / 阅读两视图切换；PWA 注册
├─ pages/
│  ├─ LibraryPage.tsx        # 书库：导入、列表、管理、备份、统计
│  ├─ ReaderPage.tsx         # 阅读页：分页/滚动渲染、翻页、划线、TTS
│  └─ ReaderMenu.tsx         # 阅读菜单：目录/书签/笔记/搜索/设置
├─ core/                     # 纯逻辑层，框架无关、可单测
│  ├─ importers/             # V5.0 多格式导入（zip/epub/markdown/html）+ V6.0 PDF（pdf.js 按需加载）
│  ├─ highlight.ts           # V4.0 批注模型与三层锚定
│  ├─ encoding.ts            # 编码探测与解码（支持强制指定）
│  ├─ pagination.ts          # Measurer 接口 + PageMap 分页引擎
│  ├─ toc.ts                 # 章节切分（内置 + 自定义正则）
│  ├─ search.ts              # 全文搜索
│  ├─ purify.ts              # 导入净化（推广行清理）
│  ├─ bookRepository.ts      # IndexedDB 读写（books/progress/bookmarks/stats/highlights）
│  └─ settings.ts            # 阅读设置（localStorage + CSS 变量）
└─ styles/theme.css          # CSS 变量主题（日间/护眼/夜间）
```

`demo/` 是早期原生 JS 原型归档，仅供对照，不参与构建。
`test-fixtures/` 存放 PDF/EPUB 等二进制样本，供 `*.test.ts` 端到端断言用。

## 文档地图

- [docs/产品设计文档.md](docs/产品设计文档.md) — 产品愿景、用户、闭环、非目标
- [docs/技术方案.md](docs/技术方案.md) — core 纯逻辑层 + PageMap 字符偏移坐标系 + CSS 变量主题
- [docs/功能迭代计划.md](docs/功能迭代计划.md) — V1.x → V6 的演进路线与验收清单
- [docs/V4.0-批注与笔记方案.md](docs/V4.0-批注与笔记方案.md) — 6 色 × 4 样式 + 容错锚定 + Obsidian 友好导出
- [docs/V5.0-多格式导入方案.md](docs/V5.0-多格式导入方案.md) — EPUB/MD/HTML 设计选型与"PDF 不做"的原始论证
- [docs/V6.0-PDF支持方案.md](docs/V6.0-PDF支持方案.md) — 上述翻案：按需加载 / 扫描版识别 / 加密提示
