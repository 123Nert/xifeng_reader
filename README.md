# xifeng 阅读

本地 TXT 电子书阅读器（Web 应用）。核心闭环：**导入一本书 → 舒服地读完 → 下次打开接着读**。

产品设计见 [docs/产品设计文档.md](docs/产品设计文档.md)，技术方案见 [docs/技术方案.md](docs/技术方案.md)。

## 功能（MVP）

- 导入本地 TXT（文件选择 / 拖拽），自动识别 UTF-8 / GB18030（含 GBK）/ UTF-16 编码，杜绝中文乱码
- 书库：书名、阅读进度、最后阅读时间，支持删除
- 阅读页：按视口与字体设置实时分页；按钮 / 键盘（←→、PageUp/PageDown、空格）/ 点按区域翻页
- 字号、行距即时调整，重排后阅读位置不丢
- 进度自动保存，重新打开精确续读；底部进度条拖动可跳转任意位置

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
├─ main.tsx / App.tsx        # 入口；书库 / 阅读两视图切换
├─ pages/
│  ├─ LibraryPage.tsx        # 书库：导入、列表、删除
│  └─ ReaderPage.tsx         # 阅读页：分页渲染、翻页、进度条
├─ core/                     # 纯逻辑层，框架无关、可单测
│  ├─ encoding.ts            # 编码探测与解码
│  ├─ pagination.ts          # Measurer 接口 + PageMap 分页引擎
│  ├─ bookRepository.ts      # IndexedDB 读写（books / progress 双 store）
│  └─ settings.ts            # 阅读设置（localStorage + CSS 变量）
└─ styles/theme.css          # CSS 变量主题（为深色主题预留）
```

`demo/` 是早期原生 JS 原型归档，仅供对照，不参与构建。
