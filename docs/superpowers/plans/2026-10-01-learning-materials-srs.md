# V6.7 学习资料中心与生词间隔复习实施计划

**目标：** 书库内统一整理批注、笔记、生词，支持书/章节/类型筛选、搜索、Markdown/CSV 导出和回到出处；增加本地间隔复习。

**架构：** 复用 IndexedDB v7；生词维持一词一卡，兼容旧记录并保留多处书籍位置。纯逻辑模块处理联合、筛选和导出，书库级页面负责交互与跳转。

**约束：** 不清库、不引入服务端或依赖；「记住了」按 1/3/7/14/30 天递进，「再复习」次日到期；最终通过 `npm test`、`npm run build`。

## 文件职责

## 文件职责

- `src/core/vocabulary.ts` / `.test.ts`：兼容归一化、多出处合并、复习排期。
- `src/core/bookRepository.ts` / `.test.ts`：全量批注、跨书查询、复习写入、删书清理。
- `src/core/studyMaterials.ts` / `.test.ts`：联合模型、过滤、Markdown/CSV 导出。
- `src/pages/StudyMaterialsPage.tsx`：跨书资料中心；`App.tsx`、`LibraryPage.tsx`：入口和视图。
- `ReaderPage.tsx`：初始字符偏移跳转；`theme.css`：主题响应式样式。
- `docs/功能迭代计划.md`：登记 V6.7 范围和验收。

## 任务 1：生词模型与复习规则

接口：`VocabSource { bookId; charIndex; excerpt; gloss?; context? }`，`VocabRecord.sources?`、`reviewStep?`、`dueAt?`、`lastReviewedAt?`；新增 `normalizeVocabRecord`、`reviewVocabRecord(record, remembered, now)`、`isVocabDue`。

- [ ] 先测旧记录、多书来源保留、相同来源去重、复习递进、遗忘次日重试和到期判定。
- [ ] 跑 `npm test -- --run src/core/vocabulary.test.ts`，确认新增断言失败。
- [ ] 实现纯函数，旧数据无迁移且兼容单一旧出处；复跑测试。

## 任务 2：仓储与备份兼容

新增 `listHighlightsAll()`、`reviewVocab(word, remembered, now)`；`listVocabByBook` 匹配所有历史出处。

- [ ] 先测跨书查询、复习持久化、删书保留其他来源/删除最后一处、旧备份导入。
- [ ] 跑 `npm test -- --run src/core/bookRepository.test.ts`，确认新增行为失败。
- [ ] 实现仓储逻辑，维持 DB v7；复跑仓储和备份测试。

## 任务 3：统一资料逻辑

在 `studyMaterials.ts` 定义联合类型与 `filterStudyMaterials`、`studyMaterialsToMarkdown`、`studyMaterialsToCsv`。

- [ ] 先测书/章/类型/待复习组合、原文/笔记/词义/语境搜索及导出转义。
- [ ] 跑 `npm test -- --run src/core/studyMaterials.test.ts` 确认失败；实现后复跑。

## 任务 4：界面及集成

- [ ] 在书库加入口和 study 视图；加载书目、批注、生词，章节复用已存 TOC 或 `buildToc`。
- [ ] 增加书/章/类型/关键词/待复习筛选、计数、空状态、两种导出及复习操作。
- [ ] 条目通过书 ID/字符偏移打开阅读页；阅读页等待分页数据后调用现有 `jumpToOffset`。
- [ ] 样式兼容窄屏和现有主题，更新功能路线图。

## 任务 5：验收

- [ ] 跑 `npm test` 和 `npm run build`；修复本次变更并复跑。
- [ ] 检查 `git diff --check`、完整 diff、旧数据和导出；不创建 commit。
