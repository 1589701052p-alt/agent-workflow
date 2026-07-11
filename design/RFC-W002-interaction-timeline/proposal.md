# RFC-W002 - 任务「评论区」交互时间线

状态：Draft（待用户批准进入实现）

## 1. 背景

任务详情页当前有 9 个 tab（`workflow-status` / `task-questions` / `node-runs` / `details` / `outputs` / `worktree-files` / `worktree-diff` / `worktree-structure` / `feedback`，见 `lib/task-detail-tabs.ts:29-41`），但**没有任何一个 tab 能让人一眼看清「这个任务里人跟 agent、agent 跟 agent 之间到底按什么顺序交互了什么」**。每类交互都被关在各自的子实体视图里：

- **agent 的原始对话 / 输出**：只能点 canvas 上某个节点 -> drawer Session tab（`components/node-session/SessionTab.tsx`），且只看得到**单个 node_run**；任务级 `NodeRunsTable` 只显示状态元数据行，无消息正文。
- **反问 Q&A**：`/clarify` 路由按轮次看，inbox 只显示元数据行（节点 id / 状态 / 问题数），看不到问答原文；`TaskQuestionList` 是阶段看板（非时间序）。
- **评审决定 / 评论**：`/reviews` 路由按节点 + 版本看，不在任务详情页内。
- **人输入的原始需求**：藏在 `tasks.inputs` JSON 里，详情页 `details` tab 只展示元数据。
- **节点间交接**（A 输出 -> B 输入）：只能从 `node_runs.consumedUpstreamRunsJson` 反推，前端无任何呈现。

用户场景（典型 设计 -> 实现 / Code -> Audit -> Fix 链路）：人的需求进来 -> agent A 出设计方案 -> 交给 agent B 实现 -> agent B 反问人 -> 人回答 -> 交回 agent A 继续设计 -> agent A 把结果传给 agent B。当前要追溯这条链路，用户必须在 4 个 tab / 路由间来回跳，且看不到一条按时间排好的「谁说了什么、产出了什么」的时间线。

`useTaskSync.ts:38-43` 的 `node.event` WS 通道**目前没有消费者**，第 40 行注释明说预留给未来的 "node-events feed"--本 RFC 即是该 feed 的第一个落地形态（MVP 走失效重取，真正流式直推留作未来增强）。

## 2. 目标 / 非目标

### 目标

- 在任务详情页新增一个**只读** tab（用户工作命名「评论区」，实质是交互时间线），按时间顺序聚合展示四类交互的**原始信息与输出结果**：
  1. **人输入需求**（`tasks.inputs`）
  2. **agent 节点输出**（`node_run_outputs.content`）
  3. **反问问题 + 人回答**（`clarify_rounds.questionsJson` / `answersJson`）
  4. **评审决定 + 评论**（`doc_versions` + `review_comments`）
- 每条交互卡片展示：类型 / 角色（人或 agent + 节点名）/ 时间（相对 + 绝对）/ 原始内容（输出走 markdown 渲染、反问走问题+选项、回答走选中项+自填、评审走决定+理由+评论）。
- agent 节点输出卡片可一键跳转该节点的 Session tab 看完整会话。
- 实时更新：复用 `useTaskSync` WS 失效机制，任务跑动时新交互自动出现。
- 复用既有公共组件与 markdown 渲染器，不造视觉孤岛（遵循 CLAUDE.md Frontend UI consistency）。

### 非目标

- **不做**自由评论写入（不新增评论表 / 写入接口 / 权限）--v1 纯只读展示（用户已确认）。
- **不做**内嵌完整 opencode 会话（prompt + 工具调用）--节点卡片只展示输出结果，细节走跳转（用户已确认）。
- **不替换**既有 siloed 视图（`TaskQuestionList` 看板、`/clarify`、`/reviews`、`SessionTab`）--本 tab 是**增量**聚合视图，与既有视图并存。
- **不做** node-to-node handoff 显式卡片 / 失败错误卡片 / 状态流转卡片--MVP 只覆盖上述四类「有原始信息内容」的交互。
- **不做**真正的流式逐事件追加渲染--MVP 走 react-query 失效 + 重取（与 `node-runs` 表一致）；`node.event` 直推渲染留作未来增强。
- **不新增数据表 / 不写 migration**--纯读侧聚合，数据全部来自既有表。

## 3. 用户故事

- **US-1**：作为任务发起人，我打开任务详情 ->「评论区」tab，就能按时间顺序看到：我最初填的需求 -> agent A 的设计方案 -> agent B 的反问 -> 我的回答 -> agent A 的第二轮方案 -> 评审决定，无需在多个 tab 间跳转。
- **US-2**：作为任务发起人，我在时间线里看到 agent A 的某条输出，点「查看完整会话」直接跳到 agent A 那个 node_run 的 Session tab 看它当时怎么推导的。
- **US-3**：作为任务发起人，任务还在跑，我切到「评论区」tab，agent B 刚反问完的问题自动出现在时间线末尾，无需手动刷新。
- **US-4**：作为 reviewer，我在时间线里看到评审决定卡（approve/reject + 理由 + 评论），点进去跳到该 review 详情。

## 4. 验收标准

1. 任务详情页出现新 tab「评论区」，位置在 `task-questions` 之后、`feedback` 之前。
2. tab 内按时间升序展示四类交互卡片，每卡含类型 chip / 角色与节点名 / 相对+绝对时间 / 原始内容。
3. 人输入需求卡展示 `tasks.inputs` 全部键值；agent 输出卡用既有 markdown 渲染器渲染 `node_run_outputs.content`；反问卡展示问题标题+选项；回答卡展示选中项标签+customText；评审卡展示决定 chip+理由+评论列表。
4. agent 输出卡「查看完整会话」按钮跳转到 `workflow-status` tab + 选中该 node_run + 打开 drawer Session 子 tab。
5. 任务运行中产生新交互（节点完成 / 反问创建 / 反问回答 / 评审决定）时，时间线自动更新（经 `useTaskSync` WS 失效），无需手动刷新。
6. 无交互时空状态走 `<EmptyState>`；加载走 `<LoadingState>`；出错走 `<ErrorBanner>`。
7. `bun run typecheck && bun run test && bun run format:check` 三项全绿。
8. 纯函数 `buildInteractionFeed(...)` 单测覆盖四类映射 + 时间排序 + 边界（空任务 / 无输出 done 节点 / 未回答反问 / 多端口输出 / 多评审版本 / 同 ts 用 sortId 兜底）；前端组件渲染测覆盖五种卡片 + 跳转；一条端到端集成测覆盖 input->A->B clarify->answer->A2->review 全链路时序。
