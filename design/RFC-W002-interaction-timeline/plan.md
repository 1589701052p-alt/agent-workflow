# RFC-W002 - 任务分解

按依赖顺序执行。每个子任务带对应测试（CLAUDE.md「测试随改动落地」）。commit message 前缀：`feat(task-detail): RFC-W002 评论区交互时间线`。

## T1: 后端纯函数 buildInteractionFeed + 单测

- 类型 `InteractionKind` / `InteractionItem` 放 `packages/shared`（前后端共用）。
- 新建 `packages/backend/src/services/interactionFeed.ts`，导出 `buildInteractionFeed(args)` 纯函数（零 IO）。
- `tests/services/interactionFeed.test.ts`：四类映射 + `(ts, sortId)` 排序 + 边界（空任务 / 无输出 done 节点 / 未回答反问 / 多端口 / 多评审版本 / 同 ts sortId 兜底 / 节点名解析失败回落）。
- 验收：纯函数单测全绿。

## T2: 后端路由 + 鉴权 + 上限

- `GET /api/tasks/:taskId/interaction-feed`，复用 `services/resourceAcl.ts` 鉴权（未授权 404 与不存在同形）。
- 拉取 `tasks` / `node_runs`(done) / `node_run_outputs` / `clarify_rounds` / `doc_versions`(decided) / `review_comments`，调 `buildInteractionFeed`。
- 硬上限 1000 + 响应附 `truncated` / `total`。
- `tests/routes/interaction-feed-routes.test.ts`：成员 / 非成员 404 / 结构 / 截断。
- 验收：路由测全绿。

## T3: 前端 tab 注册 + i18n

- `lib/task-detail-tabs.ts`：`TaskDetailTab` 加 `'timeline'`；`TAB_ORDER` 插 `task-questions` 后、`feedback` 前；`availableTabs` 始终可用。
- i18n `taskDetail.tabs.timeline` = 「评论区」/ "Timeline"（中英）。
- 验收：tab 出现且位置正确（源码层断言 `'timeline'` 在 `TAB_ORDER`）。

## T4: 前端 TaskTimeline 组件 + 卡片 + 筛选 + 状态

- `components/tasks/TaskTimeline.tsx`：`useQuery(['task-timeline', taskId])` 拉 feed；类型筛选（`.segmented` 或 chip）；五种卡片渲染。
- 复用：既有 markdown 渲染器（RFC-008）、`Card`、`EmptyState`、`LoadingState`、`ErrorBanner`、`StatusChip`、相对时间 util。**禁止**新写渲染器 / 自写 chrome。
- `components/tasks/TaskTimeline.test.tsx`：五卡渲染 + 时间顺序 + 筛选 + 跳转按钮（`findByRole`）。
- 验收：组件测全绿。

## T5: 前端 pane 挂载 + 跳转

- `tasks.detail.tsx` panes 区挂 `<TaskTimeline>`（always-mount + `hidden` 策略）。
- 跳转：`session` -> `setTab('workflow-status')` + `setSelectedNodeRun(nodeRunId)`（复用 `NodeRunsTable` 既有跳转机制）；`clarify` / `review` -> 路由跳转。
- 验收：输出卡点「查看完整会话」能切 tab + 选中节点 + 开 Session 子 tab。

## T6: WS 失效接入

- `useTaskSync.ts` 4 个分支（`node.status` / `node.event` / `review.*` / `clarify.*` / `cross-clarify.*`）各追加 `invalidateQueries({ queryKey: ['task-timeline', taskId] })`。
- 验收：源码层断言 `useTaskSync.ts` 各分支含 `'task-timeline'`。

## T7: 端到端集成测

- `tests/interaction-feed-scenario.test.ts`：input -> A done -> B clarify created -> human answer -> A2 done -> review decided，断言 feed 6 条按 `(ts, sortId)` 序。
- 验收：集成测全绿。

## T8: 门禁 + 文档同步

- `bun run typecheck && bun run test && bun run format:check` 三项全绿。
- `design/plan.md` RFC 索引 RFC-W002 状态改 **Done**。
- `STATE.md`：「进行中 RFC」行改为已完成，并在已完成 issue 表里加一行（与 P-X-XX 同等级）。

## 执行顺序

T1 -> T2 ->（T3 可与 T2 并行）-> T4 -> T5 -> T6 -> T7 -> T8

## PR 拆分

默认**单 PR**（RFC 三件套 + T1-T8 + 全部测试）。commit message：`feat(task-detail): RFC-W002 评论区交互时间线`。

## 验收清单

- [ ] 任务详情页「评论区」tab 出现，位置在 `task-questions` 与 `feedback` 之间
- [ ] 四类交互按时间升序展示，每卡含类型 / 角色 / 时间 / 原始内容
- [ ] 输出卡 markdown 渲染 + 「查看完整会话」跳转 Session
- [ ] 反问 / 回答 / 评审卡内容正确
- [ ] 运行中任务新交互自动出现（WS 失效）
- [ ] 空 / 加载 / 出错状态走公共组件
- [ ] `typecheck` / `test` / `format:check` 全绿
- [ ] 纯函数 + 路由 + 组件 + 集成测全绿
