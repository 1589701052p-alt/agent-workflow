# RFC-163 技术设计

## 1. 单一事实源：`groupBoardEntries` 纯函数

新增 shared/前端纯函数（放前端 `lib/` 或组件旁，随可断言面偏好——见测试策略）：

```ts
interface HandlerRow {           // 组内一行处理节点
  entry: TaskQuestionEntry       // 原条目（携带 id / roleKind / effectiveTargetNodeId / phase …）
}
interface BoardCard {
  key: string                    // 稳定 key
  questionTitle: string
  originNodeRunId: string | null // 分组键的一半（manual 为 null）
  questionId: string
  phase: TaskQuestionPhase        // 该卡所在列（见 §2）
  handlers: HandlerRow[]          // ≥1；下发前可 >1（提问节点 + 上游），下发后恒 =1
  grouped: boolean               // handlers.length > 1（供渲染/测试区分）
}

function groupBoardEntries(entries: TaskQuestionEntry[]): BoardCard[]
```

**规则（就是 AC-1/AC-2 的形式化）：**

1. **未下发条目**（`phase ∈ {'pending','staged'}`）：按 `(originNodeRunId, questionId)` 聚合成一张
   `BoardCard`，`handlers` = 该组全部未下发条目（提问节点条目 + 增派的 designer 条目）。
2. **已下发条目**（`phase ∈ {'processing','awaiting_confirm','done'}`）：**每条目各自一张**
   `BoardCard`（`handlers=[该条目]`，`grouped=false`）——与今日一致。
3. **manual**（`originNodeRunId===null`）：不与任何条目聚合（无提问节点共存），各自单卡。
   —— 用 `originNodeRunId` 为 null 时**退化为按 `entry.id` 分组**（每 manual 自成一组）。
4. 组内 `handlers` 保序：提问节点条目（self/questioner）在前、designer 在后（稳定、可测）。
5. 卡的 `phase` 见 §2。

> **为何不会跨列分裂**（关键不变式）：一张未下发卡的 handlers **同为未下发**，且 stage 是**组级**
> （§3）——整组要么全 `pending`、要么全 `staged`，恒在同一列。批量下发把整组一起下发。要让「一个
> `(origin,question)` 不出现『部分下发、部分未下发』」成立，**必须**「改派增 designer 只在提问条目
> 未下发时可行」——**这条守卫本 RFC 新加**（见 §3.5；Codex 设计门 P2 指出现状不保证）。
>
> **降级兜底**：即便守卫被绕过（历史遗留 / 直连 API）而出现「提问条目已下发 + designer 未下发」的
> 混态，`groupBoardEntries`（§1 case 4）**也不崩**——已下发提问条目单独一卡、未下发 designer 单独
> 一卡，各在各列、不跨列拼；后续 designer 经 board 单独下发、级联回提问节点（最终一致，只是多一次
> 提问节点重跑）。即：守卫保证「常态干净」，grouping 保证「异常不炸」。§5 单测两者都锁。

## 2. 卡所在列（`phase`）

- 未下发组：`handlers` 全 `pending` ⇒ 卡 `pending`；全 `staged` ⇒ 卡 `staged`（组级 stage 保证同步，
  §3）。防御：若极端竞态下组内混了 pending+staged（例如并发单 id stage 的历史遗留），取**最靠前**
  相位（`pending` 优先）——保守留在待指派、由用户重新整组 stage（不静默丢卡）。
- 已下发条目：各自 `phase`（processing/awaiting_confirm/done），与今日一致。

`PHASE_ORDER` 分列渲染改为：先 `groupBoardEntries(shown)` → 得 `BoardCard[]` → 每列
`cards.filter(c => c.phase === col)`（取代今日的 `shown.filter(e => e.phase === col)` 再 `map(entry)`）。

## 3. 卡级动作编排（前端调既有 per-id 端点；仅 reassign 另加一条后端守卫，见 §3.5）

| 动作 | 今日（per-card=per-entry） | RFC-163（分组卡） |
| --- | --- | --- |
| stage / unstage | 单条目 `POST /stage {staged}` | **组级**：对卡内全部未下发 handler 各调一次 `/stage`（`Promise.all`）；一张卡一个「加入待下发/移出待下发」按钮。已下发单卡＝仍单条目（无 stage 按钮）。 |
| 批量下发 | `dispatch(stagedShown.map(e=>e.id))` | 不变——`stagedShown` 现在来自 staged 卡**展开的全部 handler id**（`stagedCards.flatMap(c=>c.handlers.map(h=>h.entry.id))`）。一个 staged 组 ⇒ 其全部处理条目一起进 dispatch 批。 |
| 改派 reassign | 卡上 `Select` 改 `entry.id` 的 target | 分组卡上：`Select` 作用于**提问节点条目**（self/questioner）的 id → 后端增/删/改 designer 行（RFC-162 语义不变）；invalidate 后该卡 `handlers` 增/减一行。manual 卡：`Select` 作用于该 manual 条目自身（move override，不变）。 |
| confirm | 已下发单卡 `POST /confirm` | 不变（confirm 只在已下发单卡出现）。 |

**correctness（目标三）**：组级 stage ⇒ 提问节点与共存上游**一起 staged**；批量下发把整组一起交
`dispatchTaskQuestions` ⇒ `computeUpstreamFrontier` 对 {提问节点, 上游} 算**一个前沿**（上游起跑、
提问节点级联）。**杜绝**「只 stage 提问卡 → 下发 → 提问节点脱离上游先跑、乱序」的 board 路径隐患
（RFC-162 Finding-2 只修了 quick 自动下发路径，board 手动路径靠本 RFC 的组级动作兜住）。

## 3.5 后端守卫 + 前端门对齐（Codex 设计门 P2 —— 使 §1 不变式成立）

**唯一的后端改动**（本 RFC 因此是「前端为主 + 一小块后端硬化」，非纯前端）：

- `reassignTaskQuestion` 的 **add-designer 分支**加守卫：当**提问条目**（self/questioner，即被改派的
  `entry`）`dispatched_at IS NOT NULL` 时，**拒绝**增派 designer（`ConflictError
  'task-question-asker-dispatched'`，提示「提问节点已下发，改派前请 reopen」）。这与既有「已下发
  designer 行改派被拒」对偶——补齐提问条目侧的对称守卫，杜绝「已下发提问 + 新未下发 designer」混态。
  - 只拦「target ≠ 提问节点」的增派；`target === 提问节点`（移除 designer 回单卡）与 manual move 不受
    影响（它们不制造混态）。
- 前端门对齐：`ClarifyQuestionHandler`（`/clarify` 详情页 picker）的 `editable = asker.phase !==
  'done'` 收紧为 **`asker.phase === 'pending' || 'staged'`**——与看板 `reassignable` 一致，不再让
  processing/awaiting_confirm 态发起改派（此前是 board 与详情页门不一致的小裂缝）。

测试：后端加「对已下发提问条目增派 designer → 409 `task-question-asker-dispatched`」用例
（`rfc120-task-questions-service` 或 reassign 套件）；前端加「processing 态 ClarifyQuestionHandler
不可改派」断言。

## 4. 节点 filter / 计数 / badge

- 计数 `counts`（按 `effectiveTargetNodeId` per-entry）**不变**——chip 计数仍是「落在该节点的处理
  卡/条目数」。分组不改 per-handler 计数（否则 badge 与画布对不上）。
- **filter 按「组」匹配、保全组**（Codex 设计门 P1 修正）：**先分组、后按组过滤**——
  `cards = groupBoardEntries(entries)`；`shown = targetFilter ? cards.filter(c => c.handlers.some(h
  => h.entry.effectiveTargetNodeId === targetFilter)) : cards`。命中的**整组卡照原样渲染 + 下发**
  （保留全部 handler 行，不裁成命中那一个）。
  —— **为何不能「先滤条目再分组」**：那会把未命中的兄弟 handler 从组里删掉，批量下发展开时只发命中
  的那个 id → **重新引入部分下发/乱序**（正是 AC-3 要防的）。所以 dispatch 的 `entryIds` 必须来自
  **未经 filter 裁剪的整组**（`stagedCards.flatMap(c => c.handlers.map(h => h.entry.id))`，其中
  `stagedCards` 是 `shown` 里 `phase==='staged'` 的组、handlers 为整组）。
  —— chip 计数与展示的轻微不对称（filter 到 A、却把同组的 B handler 也显出来）是**有意**的：宁可多显
  一个兄弟 handler，也不制造部分下发。chip 仍表「落在该节点的条目数」，点它＝聚焦含该节点的问题组。
- 画布 badge 点击 focus（`focusTargetNode`）：走同一 `targetFilter`，行为不变（同样按组匹配保全组）。

## 5. 迁移与测试策略（§测试策略）

无 migration（纯前端）。**必写测试**：

- **纯函数 `groupBoardEntries` 逐格锁**（首选可断言面）：
  1. 单提问条目（无改派）→ 1 卡、`grouped=false`、handlers=[self]。
  2. 提问 + 未下发 designer（改派后）→ **1 卡** `grouped=true`、handlers=[self, designer]、保序。
  3. 提问 + designer **均已下发** → **2 卡**（各 `grouped=false`）。
  4. 提问未下发 + designer 已下发（理论混态）→ 未下发一张组卡（仅 self）+ 已下发一张单卡——**不跨列
     拼**（钉 §1 不变式）。
  5. manual ×2 → 2 卡（各自，不聚合）。
  6. 组内混 pending+staged（防御）→ 卡落 `pending`（保守），不丢 handler。
  7. filter 到某节点 → 命中的**整组卡保留全部 handler**（含未命中的兄弟 handler，§4 P1）；未含该
     节点的组不显；被保留组的 dispatch id 来自整组（不裁）。
- **组件测试**（`task-question-list.test.tsx` 扩展）：
  1. 改派回归意图：一张待指派卡点改派→**同一张卡**多一行处理节点（卡数不变），非新增第二张卡
     （断言 `tq-card-*` 数量在改派前后不变、卡内 handler 行 +1）。
  2. 组级 stage：点分组卡「加入待下发」→ 对全部 handler 各发一次 `/stage`（mock 断言调用次数=handler
     数）。
  3. 批量下发展开：staged 组的批量下发 body `entryIds` 含该组全部 handler id。
  4. 下发后拆开：已下发条目各自单卡、各带 confirm。
- **源码文本兜底锁**：`TaskQuestionList.tsx` 未下发列渲染必须走 `groupBoardEntries`（断言不再直接
  `shown.filter(phase===).map(entry=>Card)` 于未下发列）。

## 6. 失败模式 / 边界

- **组内 handler 相位竞态**：并发单 id stage 造成 pending+staged 混态 → §2 保守落 pending，用户重新
  整组 stage；不静默丢卡、不跨列。
- **改派竞态**：改派后 invalidate 重取；若下发同时进行导致 target-changed，沿用今日 dispatch onError
  的 `task-question-target-changed` 重取 + 提示（不变）。
- **空组**：不产生（每组 ≥1 handler）。
- **i18n**：分组卡新增的行标签（「提问节点（自己）」「上游（修订）」等）走既有 `taskQuestions.*` i18n
  命名空间，双语；不新造裸串。
- **视觉**：分组卡＝一个 `Card`，内部 handler 行用既有 `.btn--xs` / `StatusChip` / muted meta；不自写
  chrome（AC-7）。

## 7. 与既有工作的关系

- 建立在 RFC-162（`reassign`=增/删 designer 行、保提问条目）之上——本 RFC 只改这些条目在看板上的
  **聚合呈现** + 卡级动作编排。
- 组级下发兜住 RFC-162 Finding-2 在 board 手动路径的对偶（quick 路径已在 `448e694d` 修）。可选后续
  硬化：后端 `dispatchTaskQuestions` 对「含未下发共存 asker/designer 的部分批」也做统一（belt-and-
  suspenders）——本 RFC 先在 UX 层兜，登记为后续。
