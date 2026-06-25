# RFC-105 — 任务分解

两个工作包：**WP-A** 任务详情 Markdown 预览（纯前端，T1–T5）；**WP-B** PlantUML 后端代理通用化（前后端，T7–T8）；T9 收尾。commit 前缀 `feat: RFC-105 …`。

任务按依赖排序；每条「先写测试再实现 / 实现同时补测试」，合并前 `bun run typecheck && 前端 vitest && 后端 bun test && bun run format:check` 全绿。WP-A 不依赖 WP-B，可独立先落。

## RFC-105-T1 — 纯函数 + 单测（无依赖，先行）

- 新文件 `lib/markdown-preview.ts`：`MARKDOWN_EXT_RE` / `isMarkdownPath` / `isMarkdownPreviewable` / `validatePreviewSearch` / `resolvePreviewSource` / `buildPreviewTarget` + `TaskPreviewSearch` 类型。复用 `lib/output-port.ts` 的 `isFileOutputKind`/`isSingleLinePath` 与 shared `tryParseKind`，不重写。
- 新文件 `tests/markdown-preview.test.ts`：覆盖 design §9「纯函数单测」全部 case。
- 验收：单测绿；无 DOM 依赖。

## RFC-105-T2 — 抽出共享 worktree-file fetch（小重构，去重）

- 新文件 `api/worktreeFiles.ts`：导出 `fetchWorktreeFile(taskId, path, signal?)`（= 现 `WorktreeFilesPanel.fetchFile` 内核，含 `worktreeFileResponseSchema.parse`）。可顺带 `fetchWorktreeTree`。
- 改 `WorktreeFilesPanel.tsx`：删私有 `fetchFile`，改 import 共享版；行为不变（query key 不变 `['worktreeFile', taskId, path]`）。
- 验收：既有 `worktree-files-*` 测试不变绿；新源码守卫（T6）断言两处共用。

## RFC-105-T3 — 预览路由页 + 注册

- 新文件 `routes/tasks.preview.tsx`：`Route`（path `/tasks/$id/preview`、`validateSearch=validatePreviewSearch`）+ `TaskMarkdownPreviewPage` + `PreviewBody`（loading/error/oversized/empty/`<Prose>` 分支，§3.3–3.4）。config 取 `['config']`；file 模式用 `fetchWorktreeFile`（T2）共享 key；port 模式读 `['tasks', id, 'node-runs']` 找 output。
- 改 `router.tsx`：import + `addChildren` 注册（置于 `taskDetailRoute` 前）。
- 轻量 CSS：`styles.css` 加 `.md-preview`（最大宽度 + 内边距），其余走 `.page`/`.prose`。
- 新文件 `tests/task-markdown-preview-route.test.tsx`：file / port / invalid / oversized 四态（design §9 组件测试）。
- 验收：四态测试绿；渲染产物经角色断言（heading/table）命中。

## RFC-105-T4 — 输出区接线（TaskOutputPanel）

- 改 `TaskOutputPanel.tsx`：`OutputDetail` 新增 props `sourceRunId: string | null` + `sourcePortName: string`（由父组件已解析的 `run.id` / `port.portName` 下传，不新增查询）；header actions 区按 `isMarkdownPreviewable(kind, value)` 渲染「预览」`<Link>`（`data-testid="task-output-preview"`，目标用 `buildPreviewTarget`：文件型→file 模式，内联→port 模式）。
- 改 `tests/task-output-panel.test.tsx`：补「预览按钮显隐 + Link 目标 search 正确」case（内联 markdown / `.md` 文件 / string / 非 md 文件 / pending）。
- 验收：扩展后全绿；既有 Download/Copy/pending 断言不回归。

## RFC-105-T5 — 工作目录接线（WorktreeFilePreview）

- 改 `WorktreeFilesPanel.tsx`：`WorktreeFilePreview` 非 oversized 分支 header，按 `isMarkdownPath(path)` 在 `DownloadFileButton` 旁渲染「预览」`<Link>`（`data-testid="worktree-files-preview-btn"`，`buildPreviewTarget(taskId, path)`）。
- 新文件 `tests/worktree-files-preview-md.test.tsx`：`.md` 显示 / 非 md 不显示 / oversized `.md` 不显示。
- 验收：绿；既有 worktree-files 测试不回归。

## RFC-105-T7 — 后端 PlantUML 代理（WP-B，design §11.2）

- 新文件 `services/plantuml.ts`：`encodeForPlantuml`/`encodeForGet`（node `zlib.deflateRawSync` + 两套 base64 字母表，移植自 `PlantUmlBlock.tsx`，字节一致）、`extractPlantUmlSyntaxError`、`renderPlantuml({source,endpoint,authHeader})`（三段回退，返回判别联合）+ `PLANTUML_SOURCE_MAX`。
- 新文件 `routes/plantuml.ts`：`POST /api/plantuml/render`（仅登录、源码大小上限、读 config 端点+authHeader、返回 `{svg,host}|{unconfigured}|{syntaxError}|502{error}`，authHeader 不入响应）；在 server 路由装配处挂载。
- 测试 `tests/plantuml-proxy.test.ts` + 服务单测：design §9「WP-B 后端代理测试」全部 case（编码字节一致 / 三段回退 / 语法错停链 / 未配置 / 大小上限 / authHeader 不外泄 / SSRF 锚 / user 角色可用对照 config 403）。
- 验收：后端 bun test 绿。

## RFC-105-T8 — 前端 PlantUmlBlock 走代理 + 拆死配置链（WP-B，design §11.4）

- `PlantUmlBlock.tsx`：`fetchAndSwap` → 单次 `api.post('/api/plantuml/render',{source})` + 响应分支（svg→DOMPurify+尺寸归一 / unconfigured / syntaxError / error），删 `endpoint`/`authHeader` 参数与本地 pako 编码。
- 拆链：`makeCode`/`CodeBlock`/`Prose` 去 plantuml 入参；`ReviewDocPane` 去两 prop；`MultiDocReviewView`/`reviews.detail` 删 `['config']` 查询 + 去传参。`MarkdownEditor` 不改（自动经代理生效）。
- 测试：更新 `prose-code-plantuml.test.tsx`（走代理 mock、四态、不再直 fetch 端点）；源码层死配置链守卫（plantuml prop / config-for-plantuml 查询消失）。
- 验收：前端 vitest 绿；评审相关测试不回归。

## RFC-105-T9 — i18n + 源码守卫 + 收尾

- i18n（三处同步，缺一 typecheck 红）：`zh-CN.ts` 的 `Resources` 接口加 `taskPreview` 段（`back`/`title`/`invalidLink`/`pending`/`empty` 等）+ zh 值；`en-US.ts` 加 en 值；输出区/工作目录「预览」按钮文案；WP-B 的 plantuml 代理状态文案（未配置/渲染失败，若现有 `reviews.plantuml*` 可复用则复用）。
- 新文件 `tests/rfc105-markdown-preview-source.test.ts`：design §9「源码守卫」全部断言。
- 收尾：`STATE.md` 顶部「进行中 RFC」改 Done 并加已完成行；`design/plan.md` RFC 索引 RFC-105 状态置 Done；commit + push 后查 CI。
- 验收：typecheck 三包 + 前端 vitest + 后端 bun test + format:check 全绿；CI 全绿。

## 验收清单（合并前逐项核对）

- [ ] 输出区：内联 markdown / `.md` 文件端口出现「预览」；string / signal / 非 md 文件 / list / 空值不出现。
- [ ] 工作目录：`.md`/`.markdown` 非超限文件出现「预览」；其他不出现。
- [ ] 预览页用 `Prose` 渲染（mermaid/PlantUML/katex/代码高亮/表格/锚点逐项可见）。
- [ ] 「← 返回」回到 `/tasks/$id`。
- [ ] 失败 / 边界：loading / oversized / 403-404 / 空 / invalid-search 各有兜底。
- [ ] file 模式命中 `['worktreeFile', …]` 缓存即时首屏（背景 revalidate 可接受）。
- [ ] **WP-B**：普通 user 能渲染 PlantUML；authHeader 不外泄；未配置/语法错/失败各态；评审+编辑器预览同样生效；死配置链拆净。
- [ ] 纯函数/组件/源码守卫/后端代理测试齐全且绿。
- [ ] typecheck 三包 + 前端 vitest + 后端 bun test + format:check 全绿；CI 全绿。
- [ ] 未删他人代码（多人树原则）；commit 只描述本 RFC 改动。

## PR 拆分

建议 **2 PR**：**PR1 = WP-A**（T1–T5 + 对应 i18n/守卫，可独立交付预览功能，PlantUML 暂随现状）；**PR2 = WP-B**（T7–T8 + 代理 i18n/守卫，平台级 PlantUML 通用化）。亦可合一单 PR。T9 收尾随末一个 PR。

## Codex 双 gate

- **设计 gate**：三件套落档后、动手前跑 Codex review（[feedback_codex_review_after_changes]）。**已跑一轮**（2 findings 已 fold）；WP-B 扩范围后**再跑一轮**（代理有安全面）。
- **实现 gate**：代码完成、声明 done 前再跑一次，修掉 findings。
