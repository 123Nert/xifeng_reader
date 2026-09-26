# xifeng 阅读

本地 TXT 电子书阅读器（Web 应用）。核心闭环：**导入一本书 → 舒服地读完 → 下次打开接着读**。

产品设计见 [docs/产品设计文档.md](docs/产品设计文档.md)，技术方案见 [docs/技术方案.md](docs/技术方案.md)。

## 功能

- 导入 **TXT / EPUB / Markdown / HTML**（多选批量导入，拖拽即可）
- TXT 自动识别 UTF-8 / GB18030（含 GBK）/ Big5 / UTF-16，可手动指定编码
- EPUB 解析真实章节与目录、提取封面与作者（零依赖自研解析）
- 书库：书名、阅读进度、最后阅读时间、搜索/排序/重命名/批量删除、阅读时长统计（今日/本周/累计）
- 阅读页：分页 / 连续滚动两种模式；按钮 / 键盘 / 点按区域翻页；自动翻页；TTS 朗读（读完自动翻页）
- 排版：字号、行距、段距、页边距、首行缩进、两端对齐、字体预设与自定义字体
- 主题：日间 / 护眼 / 夜间
- 导航：章节目录（内置 + 自定义正则）、书签、全文搜索（页面内高亮）、划线笔记（可导出 Markdown）
- 进度自动保存，重新打开精确续读；进度条拖动跳转任意位置
- PWA 可安装，离线可读；备份导出 / 导入（全量 JSON）

## 运行

需要 Node ≥ 20。

```bash
npm install
npm run dev        # 开发（http://localhost:5173）
npm run test       # Vitest 单元测试
npm run build      # 产出纯静态文件到 dist/
npm run preview    # 本地预览构建产物
```

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
│  ├─ importers/             # V5.0 多格式导入（zip/epub/markdown/html）
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
