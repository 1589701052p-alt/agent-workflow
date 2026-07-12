# RFC-W002 - 技术设计

## 1. 总体架构

纯读侧、增量、无新表、无 migration。后端新增一个聚合端点 + 一个纯函数，前端新增一个 tab + 组件，WS 失效复用既有 `useTaskSync`。

```
[既有表，只读] tasks / node_runs / node_run_outputs / clarify_rounds / doc_versions / review_comments
                  │  (read-only UNION，零 IO 纯函数)
                  ▼
   services/interactionFeed.ts  ── buildInteractionFeed(...) ── 按 (ts, sortId) 排序 ──► InteractionItem[]
                  │
                  ▼
   GET /api/tasks/:taskId/interaction-feed   (react-query key ['task-timeline', taskId])
                  │
                  ▼
   前端 TaskTimeline.tsx ── 渲染时间线卡片 ── 复用 markdown 渲染器 / Card / EmptyState / LoadingState / ErrorBanner
                  │
                  ▼
   useTaskSync WS 失效：node.status / node.event / review.* / clarify.* / cross-clarify.* -> invalidate ['task-timeline', taskId]
```

## 2. 数据来源（逐类交互 -> 表.列）

| 交互类型 | 来源表.列 | 时间戳（主排序键） | sortId（ULID 兜底） | 原始内容字段 |
|---|---|---|---|---|
| 人输入需求 | `tasks.inputs` (schema.ts:483) | `tasks.startedAt` (schema.ts:488) | task id | JSON `Record<string,string>` 全量键值 |
| agent 节点输出 | `node_runs`(status=done) join `node_run_outputs` (schema.ts:876) | `node_runs.finishedAt` (schema.ts:634) | node_run id | `node_run_outputs.content` (schema.ts:883)，按 portName 聚合 |
| 反问问题 | `clarify_rounds` (schema.ts:1200) | `clarify_rounds.createdAt` (schema.ts:1249) | round id | `questionsJson` (schema.ts:1232) `ClarifyQuestion[]` |
| 人回答 | `clarify_rounds`(已回答) | `clarify_rounds.answeredAt` (schema.ts:1251) | round id | `answersJson` (schema.ts:1233) `ClarifyAnswer[]` + `answeredBy` (schema.ts:1252) |
| 评审决定/评论 | `doc_versions`(decided) join `review_comments` (schema.ts:908 / 1003) | `doc_versions.decidedAt` | doc_version id | `decision` (schema.ts:925) + `decisionReason` (schema.ts:934) + `commentsJson` (schema.ts:924) / `review_comments` |

**节点元信息**（节点名 / agent 名）从 `tasks.workflowSnapshot` (schema.ts:458) 的 frozen definition 按 `nodeId` 解析；解析失败时回落展示 nodeId，不崩。

**遗留表注意**：`clarify_sessions` / `cross_clarify_sessions`（RFC-058 前的表）仍存在；统一从 `clarify_rounds` 读（当前事实源），遗留行已被迁移过来。

**排序键选择理由**：ULID `id` 列是时间前缀、单调，跨表亦可按 sortId 字典序兜底；但「反问」与「回答」是同 round 的两个不同时间点事件，回答事件的时间用 `answeredAt`（晚于 round 创建），所以主排序键用各事件语义时间戳 `ts`，`sortId` 只在 `ts` 相同时兜底单调。这样 `问 -> 答` 的先后正确。

## 3. InteractionItem 契约

类型放 `packages/shared`（前后端共用）。

```ts
export type InteractionKind =
  | 'human_input' | 'node_output' | 'clarify_question' | 'clarify_answer' | 'review_decision'

export interface InteractionItem {
  id: string                 // 唯一项 id：'input:<taskId>' / 'output:<nodeRunId>' / 'question:<roundId>' / 'answer:<roundId>' / 'review:<docVersionId>'
  kind: InteractionKind
  ts: number                 // 事件时间（ms）-- 主排序键
  sortId: string             // ULID 兜底 tiebreaker（跨表时钟偏差时保单调）
  nodeId?: string            // 工作流节点 id（输出/反问/评审）
  nodeRunId?: string         // node_run id（跳转 Session 用）
  agentName?: string         // 展示用
  nodeName?: string          // 展示用
  title: string              // 一行摘要（如 "agent A · 设计方案" / "agent B 反问" / "人回答" / "评审通过"）
  // 各 kind 专属载荷（只填对应那个）：
  inputs?: Record<string, string>                          // human_input
  outputs?: { portName: string; content: string; kind: string }[]  // node_output（一个 node_run 的全部端口）
  questions?: ClarifyQuestion[]                            // clarify_question
  answers?: ClarifyAnswer[]                                // clarify_answer
  review?: { decision: string; reason: string | null; comments: { selectedText?: string; commentText: string; author?: string }[] }  // review_decision
  jumpTarget?: { kind: 'session' | 'clarify' | 'review'; nodeRunId?: string; roundId?: string; docVersionId?: string }
}
```

- **节点输出**：一个 `node_run` 一张卡（不按端口拆卡），卡内 `outputs[]` 列出该 run 全部端口；这样「agent A 的设计方案」是一条卡，与用户叙事一致。空输出（done 但 `node_run_outputs` 无行）跳过，不展示空卡。
- **反问 / 回答**：拆成两张独立卡（问在 createdAt、答在 answeredAt），各自可跳同 round；未回答时只产 `question` 卡，`answer` 卡不产。
- **评审**：每个已决定（decided）`doc_version` 一张卡，含决定 + 理由 + 评论列表（合并 `commentsJson` 与 `review_comments`，去重）。未决定的版本 MVP 不入时间线。

## 4. 后端

### 4.1 纯函数 `buildInteractionFeed`

`packages/backend/src/services/interactionFeed.ts`：

```ts
export function buildInteractionFeed(args: {
  task: { id: string; startedAt: number | null; inputs: Record<string, string> | null }
  nodeRuns: { id: string; nodeId: string; finishedAt: number | null; status: string }[]
  outputs: { nodeRunId: string; portName: string; content: string; kind: string }[]
  clarifyRounds: ClarifyRound[]
  docVersions: { id: string; reviewNodeRunId: string; sourceNodeId: string | null; decision: string; decisionReason: string | null; decidedAt: number | null; commentsJson: string | null }[]
  reviewComments: { docVersionId: string; selectedText: string | null; commentText: string; author: string | null }[]
  workflowSnapshot: { nodes: { id: string; name?: string; agentName?: string }[] }
}): InteractionItem[]
```

- 各源分别映射成 `InteractionItem[]`，合并后按 `(ts asc, sortId asc)` 排序。
- **纯函数、零 IO**--可单测，不依赖 DB。这是 CLAUDE.md「首选可断言面」要求的纯数据预言。
- 节点名 / agent 名解析：从 `workflowSnapshot.nodes` 按 `nodeId` 查；命中失败回落 nodeId。

### 4.2 路由 `GET /api/tasks/:taskId/interaction-feed`

- **鉴权**：复用既有任务成员 / 可见性校验（`services/resourceAcl.ts`；任务恒为成员制私有，D20）。未授权 -> 404，与「不存在」同形。
- **查询**：一次拉 `tasks` + 该 task 的 `node_runs`(done) + `node_run_outputs` + `clarify_rounds` + `doc_versions`(decided) + `review_comments`，调 `buildInteractionFeed` 返回。
- **上限**：MVP 不做游标分页，返回全部 item；硬上限 1000 条（按 ts 最近的 1000），响应附 `truncated: boolean` + `total`，UI 截断时显式提示「仅显示最近 1000 条」。游标分页留作未来增强（loop wrapper 长任务可能超量）。
- **缓存**：react-query `['task-timeline', taskId]`，`staleTime: 0`（WS 失效驱动刷新）。

### 4.3 WS 失效

`packages/frontend/src/hooks/useTaskSync.ts` 现有分支追加 `queryClient.invalidateQueries({ queryKey: ['task-timeline', taskId] })`：

- `node.status`（useTaskSync.ts:28）-> 节点完成，新增 node_output 时间线条目
- `review.*`（useTaskSync.ts:47-69）-> 评审决定 / 评论
- `clarify.*`（useTaskSync.ts:74-90）-> 反问 / 回答
- `cross-clarify.*`（useTaskSync.ts:95-97）-> 跨节点反问

**不新增 WS 事件类型**--完全复用既有事件 taxonomy，只在 4 个分支各加一条失效。

**`node.event` 故意不失效**：它每个 opencode 事件（逐 token）触发，而时间线只在节点 done（输出落盘）时变化；done 转换由 `node.status` 覆盖。`task-detail__pane` 是 always-mount（RFC-021），timeline 的 useQuery 即使 tab 隐藏也 active，逐 token 失效会引发对 6 表聚合 feed 的高频无谓重取。源码层兜底断言锁住「4 分支含 / node.event 分支不含」（见 `hooks/__tests__/useTaskSync-timeline-invalidation.test.ts`）。

## 5. 前端

### 5.1 tab 注册

`packages/frontend/src/lib/task-detail-tabs.ts`：

- `TaskDetailTab` 联合类型加 `'timeline'`。
- `TAB_ORDER` 插入位置：`task-questions` 之后、`feedback` 之前（都是交互向，且 `feedback` 刻意保持最后作「反思」位）。
- `availableTabs`：始终可用（任何任务都可能产交互）。
- i18n：`taskDetail.tabs.timeline` = 「评论区」（用户工作命名；中英双语，en = "Timeline"）。

### 5.2 组件 `components/tasks/TaskTimeline.tsx`

- **顶部筛选**：类型筛选 chip 组（全部 / 人输入 / 输出 / 反问Q&A / 评审），短列表互斥走 `.segmented` 或既有 chip 体系；client 端过滤。
- **主体**：竖向时间线，每条 `InteractionItem` 一张卡，可选按日期分组（day header）。
- **卡片**：复用公共 `Card`（RFC-124）；类型 chip 走既有 `StatusChip` / chip 体系；时间走既有相对时间 util。
- **内容渲染**：
  - `human_input`：`inputs` 键值列表。
  - `node_output`：每个端口 `content` 走**既有 premium markdown 渲染器**（RFC-008 引入，react-markdown + shiki + KaTeX；实现时在 `packages/frontend/src/components/` 下定位其导出复用，**禁止**新写渲染器）。底部「查看完整会话」按钮 -> `jumpTarget.session`。
  - `clarify_question`：问题标题 + 选项列表（label / description / recommended 标记）。
  - `clarify_answer`：选中项标签 + customText；顶部小字关联同 roundId 的问题。
  - `review_decision`：决定 chip（approved / rejected / iterated）+ 理由 markdown + 评论列表（selectedText + commentText + author）。
- **跳转**：
  - `session` -> `setTab('workflow-status')` + `setSelectedNodeRun(nodeRunId)` + drawer 默认开 Session 子 tab（复用 `NodeRunsTable` 现有 Review / Clarify 跳转同一机制与 state setter）。
  - `clarify` -> 路由 `/clarify/<nodeRunId>`。
  - `review` -> 路由 `/reviews/<nodeRunId>`。
- **状态**：空 `<EmptyState>` / 加载 `<LoadingState>` / 出错 `<ErrorBanner>`--禁止自写 `<div className="error-box">`。
- **截断提示**：`truncated` 为真时顶部一条提示条。

### 5.3 接入

`packages/frontend/src/routes/tasks.detail.tsx`：在 panes 区（:358-614）加：

```tsx
<div className="task-detail__pane" hidden={tab !== 'timeline'}>
  <TaskTimeline taskId={taskId} />
</div>
```

沿用 always-mount + `hidden` 策略（RFC-021），不破坏其他 tab 的 xyflow 视口 / react-query 缓存。

## 6. 与现有模块耦合点

| 模块 | 耦合 | 风险 |
|---|---|---|
| `useTaskSync.ts` | 追加 1 条失效 key（4 个分支） | 低，纯追加 |
| `lib/task-detail-tabs.ts` | tab 注册 | 低，类型 + 数组追加 |
| `tasks.detail.tsx` | pane 挂载 + 跳转 state setter 复用 | 低，复用既有 state |
| `services/resourceAcl.ts` | 端点鉴权复用 | 低，既有 API |
| markdown 渲染器（RFC-008） | 输出 / 评审理由渲染 | 低，只读复用 |
| `Card` / `EmptyState` / `LoadingState` / `ErrorBanner` / `StatusChip` | 公共组件复用 | 低 |

## 7. 失败模式

| 失败 | 处理 |
|---|---|
| 端点 404（任务不存在 / 无权限） | 与「不存在」同形；前端 `<ErrorBanner>` 提示 |
| `workflowSnapshot` 解析节点名失败（节点已删 / 快照损坏） | 卡片回落展示 nodeId，不崩 |
| `node_run_outputs.content` 为空（done 但无输出） | 跳过该输出卡，不展示空卡 |
| `clarify_rounds.answersJson` 为 null | 只展示 question 卡，answer 卡不产 |
| 超大任务（成百上千 node_run） | 硬上限 1000 + `truncated` 提示；未来增强游标分页 |
| markdown 渲染恶意内容 | 复用 RFC-008 渲染器 sanitize（rehype 管线已禁 raw） |
| `ts` 为 null（节点未完成 / 评审未决定） | 不入时间线（MVP 只展示已完成事件） |

## 8. 测试策略

- **纯函数单测**（`tests/services/interactionFeed.test.ts`）：四类映射各覆盖 + `(ts, sortId)` 排序 + 边界（空任务 / 无输出 done 节点 / 未回答反问 / 多端口输出 / 多评审版本 / 同 ts 用 sortId 兜底 / 节点名解析失败回落）。锁：未来 refactor 改排序或映射逻辑即红。文件顶部注释写明本测试锁的是 RFC-W002 的时间线聚合契约。
- **路由测**（`tests/routes/interaction-feed-routes.test.ts`）：成员可见 / 非成员 404 / 响应结构 / `truncated` 上限。
- **组件测**（`components/tasks/TaskTimeline.test.tsx`）：mock items，`findByRole` 断言五种卡片渲染 + 时间顺序 + 筛选 + 跳转按钮触发 setTab / setSelectedNodeRun。
- **集成测**（`tests/interaction-feed-scenario.test.ts`）：input -> A done -> B clarify created -> human answer -> A2 done -> review decided，断言 feed 6 条按序。
- **源码层兜底断言**（CLAUDE.md 要求的最低兜底）：`'timeline'` 必须出现在 `TAB_ORDER`；`useTaskSync.ts` 各分支必含 `'task-timeline'` 失效（grep 级文本断言）。
