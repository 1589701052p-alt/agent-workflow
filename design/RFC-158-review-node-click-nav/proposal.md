# RFC-158 任务画布评审节点点击直达评审页 — proposal

状态：Done（设计门 7 轮收敛 → 用户批准 → 实现 → 实现门；门禁全绿）
提出：用户 2026-07-09「在任务详情界面，评审节点的侧边详情栏好像什么有意义的信息都没有，那就把点击评审节点的动作修改为打开评审页面就行了。如果该节点还没产生评审则无法点击，如果正在等待评审则打开评审界面，如果已经完成评审则点击回显最后一次评审结论页」

## 1. 背景

任务详情页（`/tasks/$id`）的「工作流状态」页签是一张只读画布（`TaskStatusCanvas`），
点击任意节点会打开右侧 `NodeDetailDrawer`（Session / Events / Output / Stats 四页签，
`packages/frontend/src/components/NodeDetailDrawer.tsx:1-9`）。

这套 drawer 是为「有 opencode 进程」的 agent 节点设计的。对 `review` 节点它几乎全空：

- **Session**：review 节点无自有会话，渲染 "N/A" 占位（`workflowNodeKind` 判定）。
- **Events**：只有零星 `review.created` 一类原始事件。
- **Output**：只有 `approved_doc` / `approval_meta` 两个机器端口的裸文本。
- **Stats**：一段等待人工的计时（RFC-078 已把它和普通耗时统一显示）。

而评审的真正内容——文档正文、批注、决策按钮 / 最终结论——全部在专门的评审页
`/reviews/$nodeRunId`（`routes/reviews.detail.tsx`）。目前从任务详情到评审页只有两条迂回路径：
「节点运行」表格里 `awaiting_review` 行的「评审」按钮（`tasks.detail.tsx:870-882`），
或顶部导航去 `/reviews` 收件箱再找回来。画布上那个醒目的琥珀色呼吸灯节点反而点不出任何有用的东西。

## 2. 目标

把任务详情画布上 **review 节点的点击动作从「打开 NodeDetailDrawer」改为「直达评审页」**，按节点当前评审状态三分：

判据的关键：裸链 `/reviews/{runId}` 渲染的是该行的**当前轮**（`getReviewDetail` 挑最高
versionIndex / 最新轮），**不认历史上曾有的结论**。所以「已完成评审」必须判为「**当前轮**
就是人工结论」，而非「曾经人工决策过」——否则一行在人工决策后又开出新 pending 轮时，点进去
是空的 pending 页而非旧结论。

服务端把每个评审 run 派生成 `reviewNavKind: 'awaiting' | 'decided' | null`——一处算全「有可
渲染当前轮（有 doc_version、裸链不 404）+ awaiting/decided 分类」，前端只按 ULID 挑最新：

| 节点评审状态 | `reviewNavKind` | 点击行为 |
|---|---|---|
| 还没产生评审 / 当前轮非人工结论 / 无可渲染轮（排队 / 派发失败 / 被跳过 / 当前轮新 pending / 仅系统代决〔sibling cascade 兄弟、re-park 后被 supersede〕/ **空 `list<md>` 的零版本 awaiting**） | `null` | 无法点击（无 drawer、无跳转） |
| 正在等待评审（`awaiting_review` 且**有可渲染 doc_version**） | `awaiting` | 打开该轮评审界面 `/reviews/{该 node_run id}`（可交互：批注 + 决策） |
| 已经完成评审（**当前轮是人工结论**：裸链渲染的那一版 `decision ∈ {approved, rejected, iterated}` 且 `decidedBy` 非系统） | `decided` | 打开该行 `/reviews/{该 node_run id}`，页面呈现 RFC-149 的 `decided` 只读回显（结论 chip、理由、批注冻结） |

「最近评审结论」在被打回（reject / iterate）后、上游**尚未重跑完**的窗口内可达——此时当前轮
就是那条人工 iterate/reject 版（还没 re-park 出新 pending 轮），点击回显它（为什么被打回、
批注是什么）。一旦上游重跑完成、评审 re-park 出新 pending 轮，节点即回到「正在等待评审」。

## 3. 非目标

- **不动 clarify / cross-clarify 节点**：它们点击仍走 drawer（如需同等待遇另立 RFC）。
- **不动「节点运行」表格**的「评审」/「反问」跳转按钮——保留为补充入口。
- **不动评审页本身**（`/reviews/$nodeRunId` 的 awaiting / decided / historical 渲染逻辑，RFC-149 已收敛）。
- **后端仅两处最小改动，不碰调度 / 决策流 / 广播 / ACL / migration**（设计门五轮勘误的产物）：
  1. `getTaskNodeRuns` 在既有 RFC-078 派生栈点为每行 stamp `reviewNavKind`
     （判据唯一事实源——由共享纯选择器 `selectCurrentReviewRound` 与 `getReviewDetail` 同源，
     一处算全「有可渲染当前轮 + 当前轮是否人工结论」；`reviewIteration` 等行级信号被 sibling
     cascade 的系统代决污染、「曾经人工」被 re-park 新轮盖过、「只判 awaiting」被空 list review
     零版本击穿，都不能当判据）；
  2. `getReviewDetail` 摘要按 nodeRunId 直建，**随行修复**既有潜伏 bug：老评审版本跌出全局
     最新 500 条 doc_versions 后详情 404（收件箱历史链接今天就踩得到，本 RFC 的直达链把它
     变成一等路径）。
- **不首类化「空评审页」**：空 `list<md>` review（零 doc_version 的 awaiting）今天点 node-runs
  表「评审」按钮就 404——这是先于本 RFC 的既有 bug；本 RFC 只保证 canvas 不制造新 404（该
  节点判 `null` 不可点），不顺修空评审页的渲染/审批，留作后续 RFC。
- **工作流编辑器画布零变化**：新 prop 不传即字节不变（golden-lock，与 `questionCounts` /
  `clarifyDirectives` 同款约定）。
- 不新增视觉基线：8 张截图页均不含任务详情画布。
- `listReviewSummaries` 列表接口自身的全局 limit 语义不在本 RFC 改动（只让详情不再依赖它）。

## 4. 用户故事

1. 我在看一个停在评审上的任务（节点琥珀色呼吸），直接点那个节点 → 进入评审页开始批注 / 决策；不再先弹一个空 drawer 再去表格里找按钮。
2. 评审我上周已批准，今天回看任务时点评审节点 → 直接回显那轮结论页（approved chip + 理由 + 当时的批注）。
3. 我把评审打回了（iterate），上游 agent 还在重跑（评审尚未开出新一轮）；点评审节点 → 回显我刚才那轮 iterated 的结论与批注，确认打回理由写清楚了。上游跑完、评审开出新一轮后，这个节点回到「正在等待评审」，点它进入新一轮交互页。
4. 任务刚启动、评审节点还是灰色 → 点它没有任何反应（也不会弹空 drawer）；节点上没有「可点击」暗示。
5. 我先点了灰色评审节点（无反应），几秒后它变琥珀了，我再点 → 正常进评审页（点击不因先前选中被吞掉）。
6. 工作流里两个评审共享同一上游，我 reject 了其中一个、另一个被系统连带拉回重跑——那个**从未被我评审过**的兄弟节点不会假装「有结论可看」（不可点击）。
7. 一个跑了很久的老任务（之后系统里又产生了成百上千轮新评审），我回头点它的评审节点 → 结论页照常打开，不会 404。
8. 点进去的永远不是空白页：只要节点标成可点击，裸链一定能渲染——不会出现「标了 decided、打开却是没决策信息的 pending 轮」，也不会出现「空 `list` 评审标可点却跳 404」。

## 5. 验收标准

1. 任务详情画布点击 review 节点**永不**打开 `NodeDetailDrawer`（含 drawer 已开时点击 review 节点：drawer 关闭且不重开）。
2. `reviewNavKind='awaiting'` 时点击 → 路由跳到 `/reviews/{该 run id}`。
3. `reviewNavKind='decided'` 时点击 → 跳到 ULID 序最新的一条此类行的 `/reviews/{id}`；**打回重跑但上游未跑完窗口（当前版=人工 iterate/reject，尚未 re-park 新轮）必须命中本条**（设计门 R1 勘误锁定的主场景）。
4. `reviewNavKind=null` → 点击零动作，涵盖：**sibling cascade 只被系统代决过的兄弟行**（R2a）、**re-park 出新 pending 轮后被 supersede 置 canceled 的行**（R3，当前轮是新 pending 不得导航到空 decided 视图）、**空 `list<md>` 的零版本 awaiting**（R5，不得跳 404）、旧 daemon 未派生该字段（严判 `=== 'awaiting'/'decided'`）。
5. 可点击的 review 节点有可见提示：`awaiting` →「点击打开评审」、`decided` →「点击查看最近评审结论」（i18n 双语），并呈 pointer 光标；不可点击时无提示、默认光标。
6. review 节点点击后 xyflow 选中态被立即释放（`clearSelection`），同一节点的连续点击每次都生效（防「已选中节点再点被吞」的 wedge，机制同 tasks-detail-drawer-close-reclick 锁定的回归）。
7. **点即可渲染，无空视图无 404**：`reviewNavKind !== null` ⟺ 该 run 有可渲染 doc_version 且（awaiting 或当前轮人工结论），判据由与 `getReviewDetail` 同源的 `selectCurrentReviewRound` 派生。
8. 老评审详情不受全局 doc_versions 截断影响：插入 500+ 条更新版本后，直达 `/reviews/{老 run}` 仍正常渲染（修复前 404 的回归测试先红后绿）。
9. 工作流编辑器（`/workflows/$id`）画布行为与像素不变；任务详情画布对非 review 节点行为不变；`/reviews` 列表页行为不变。
10. `bun run typecheck && bun run lint && bun run test && bun run format:check` 全绿；既有锁测试按盘点迁移（见 design §6）。
