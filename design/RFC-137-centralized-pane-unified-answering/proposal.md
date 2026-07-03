# RFC-137 — 集中回答面板统一答题：去掉逐题「设计者/反问者」选择器（跨节点处理节点默认=设计节点）

- 状态：Done（2026-07-03 用户批准后交付；Codex 设计门 3 轮收敛 + 实现门 clean）
- 触发：2026-07-03 用户「在问题列表界面回答问题的时候，不要区分同节点反问问题和跨节点反问问题，只用把跨节点反问问题的处理节点默认标记为设计节点就行了」+ 4 项拍板（见「显式决策」）。
- 范围：仅前端集中回答面板（`CentralizedAnswerDialog.tsx`）。零后端改动 / 零 API 变化 / 零 migration。

## 背景

RFC-059 给跨节点反问轮引入了逐题 scope（`designer` / `questioner`）：答题人在回答每道跨节点问题时要额外选择「这条答案交给设计节点处理，还是只回给反问者」。RFC-128 的集中回答面板（任务问题清单 →「处理待指派问题」）镜像了这个控件——跨节点轮的每道 fresh 题渲染一个 `.segmented` designer↔questioner 选择器（`CentralizedAnswerDialog.tsx:665-693`），RFC-136 重答题则显示只读 scope 文本（`:657-664`），提交体对 cross 轮携带 `questionScopes`（`:579-591`、`:262-264`）。

用户反馈：在问题列表界面答题时**不想区分**同节点与跨节点问题——答题就是答题，两类问题应当同形；跨节点问题的处理节点**默认标记为设计节点**即可（这正是 scope 的既有默认值 `designer` 的语义：seal 后派生设计者条目，`defaultTargetNodeId` = `to_designer` 边指向的设计节点）。真有特殊情况，用既有的处理节点改派（RFC-127 可改到任意节点）解决，不需要答题时逐题做路由决策。

## 目标

1. 集中回答面板对同节点轮与跨节点轮的**答题面完全同形**：逐题渲染 =（重答提示如有）+ 答案输入，不再出现任何 scope 控件或 scope 只读文本。分组头来源文案（D3 保留展示）与 `ClarifyQuestionHandler` 处理节点回显/改派（D4 的可见载体，按 designer 条目存在性自显）是**保留面**，不在同形口径内（边界同 AC-5）。
2. 面板提交体不再携带 `questionScopes`；跨节点 fresh 题的 scope 落到服务端既有默认 `designer`——即处理节点默认=设计节点，与用户从不触碰选择器的现状默认路径**派生语义等价**（存储形状差异——`question_scopes_json` 落 NULL 而非全默认 JSON——显式接受，全部读取方默认兜底，见 design §2）。
3. 既有测试联动改写，新增「面板不区分同/跨节点」的回归锁。

## 非目标

- **不动 `/clarify/$nodeRunId` 详情答题页**：选择器、Q/W 快捷键、底部 scope 分布提示、sealed 只读 chips 全部保留（用户拍板 D1）。scope 语义在系统内仍完整可用，只是问题列表入口不再暴露。
- **不动后端 scope 机制**（用户拍板 D2）：`POST /api/clarify/:nodeRunId/answers` 的 `questionScopes` 字段、`resolveQuestionScope` 默认解析、`reconcileDesiredEntries` 的 scope 分支、`clarify_rounds.question_scopes_json` 列全部原样保留。
- **不动来源类展示**（用户拍板 D3）：面板分组头「来自节点 X 的第 n 轮（跨节点）」、/clarify 收件箱的「跨节点/本节点」chip 与 →设计节点 箭头、`ClarifyQuestionHandler` 的处理节点回显/改派，一律照旧。
- 不追溯历史数据；不改 RFC-136 重答的服务端 scope 锁定语义（D6：reseal 保持原 scope，服务端忽略误传）。

## 用户故事

- **US-1**：我在任务问题清单点「处理待指派问题」，面板里同节点和跨节点的问题长得一样——我逐题填答案、一次提交，不需要理解「设计者/反问者」是什么。
- **US-2**：我答完一道跨节点问题后，看板上出现目标=设计节点的待下发卡片（处理节点默认标好了）；如果这条答案其实不需要设计节点处理，我在卡片上改派到别的节点（含改回反问者本人，RFC-134 回执保证提问节点也能收到）。
- **US-3**：我把一道已答的跨节点问题移回待指派后重新打开面板改答案（RFC-136），流程与普通题一致，不会看到 scope 相关的额外信息。

## 验收标准

- **AC-1**：集中面板中，跨节点轮的 fresh 题**不渲染** scope 选择器（`centralized-scope-{qid}` testid 不存在），控件、状态、点击路径全部删除。
- **AC-2**：跨节点重答题**不渲染**只读 scope 行（`centralized-scope-readonly-{qid}` 不存在）；重答提示（`centralized-resubmit-hint-*`）保留。
- **AC-3**：面板提交体不含 `questionScopes` 字段——纯 fresh、纯 reseal、fresh+reseal 混合、多轮批量提交皆然。
- **AC-4**（后端不变式，既有测试锚定）：未传 `questionScopes` 的跨节点 fresh seal → 逐题 scope 解析为默认 `designer` → 派生设计者条目 `defaultTargetNodeId` = 设计节点（`cross-clarify-question-scope.test.ts` 的「未传 scope → designer 默认 + both tables NULL」case 已锁，本 RFC 不改后端、只引用为契约）。显式接受随之而来的存储/DTO 差异：面板提交的 cross 轮 `question_scopes_json` 为 NULL（原为全默认 JSON），全部读取方经 `resolveQuestionScope` 默认兜底（design §2）。
- **AC-5**：同节点轮渲染与现状一致（本来就无 scope UI）；面板内同/跨节点的**答题面**同形——问题、重答提示、答案输入完全一致，无任何 scope 控件/文本。两类**保留面**不在同形口径内：分组头来源文案（D3 展示保留）与 `ClarifyQuestionHandler` 处理节点回显/改派（按 designer 条目存在性自显——cross 题 seal 后显示「处理节点=设计节点」正是 D4 的可见载体，self 题无 designer 条目故不显示；该组件行为零改动）。
- **AC-6**：`/clarify` 详情页零变化，其既有测试（`cross-clarify-scope-control.test.tsx` 等）不动、保持全绿。
- **AC-7**：RFC-136 重答语义不变：历史已提交 scope=`questioner` 的题重答后仍保持 questioner 派生面（服务端 D6 锁定原值；该 scope 在详情页 sealed 只读 chips 仍可见，信息可达性不丢）。

## 显式决策（用户已拍板 2026-07-03）

| #   | 决策                         | 内容                                                                                                                                                                                   |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 改动范围=仅集中回答面板      | `/clarify/$nodeRunId` 详情页保留完整 scope UI（选择器 + Q/W + 分布提示）。系统内并存两个答题入口、两种表面形态，语义收敛由默认值保证。                                                 |
| D2  | 后端 scope 机制保留          | 只藏 UI：API 仍接受 `questionScopes`（详情页仍在发送），reconcile scope 分支、DB 列、shared helper 全不动。                                                                            |
| D3  | 来源展示保留                 | 「哪个节点问的、目标设计节点是谁」等信息照旧展示；只统一「回答」交互。                                                                                                                 |
| D4  | 「仅反问者」不再有面板级开关 | 跨节点答案一律派生设计者条目（处理节点默认=设计节点）；特殊情况对该条目用既有改派（RFC-127 任意节点、RFC-134 改派回执）。接受与 scope=`questioner`（完全不生成设计者条目）的行为差异。 |
