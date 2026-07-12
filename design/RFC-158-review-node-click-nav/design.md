# RFC-158 任务画布评审节点点击直达评审页 — design

## 1. 现状与依据（文件:行号）

- 画布点击 → drawer：`tasks.detail.tsx:772-779` `WorkflowCanvas.onSelect` 把节点 id 经
  `latestRunByNode`（startedAt 序，`:742-753`）映射成 node_run id，`setSelectedNodeRunId`
  挂出 `NodeDetailDrawer`（`:366-385`）。review 节点由此打开四页签空 drawer。
- 点击派发与吞点击：`WorkflowCanvas.tsx:1292-1300` `onNodeClick` 用
  `lastEmittedSelectionSig` 去重——同一节点第二次点击**不再 emit**；xyflow 自身对已选中节点的
  click 也 no-op（`:1236` 注释）。解药是命令式 `clearSelection()`（`:1240-1252`）：
  `unselectNodesAndEdges()` + 签名重置。`tasks-detail-drawer-close-reclick.test.ts` 锁的正是这套机制。
- 评审页：`routes/reviews.detail.tsx:44-54`，路由 `/reviews/$nodeRunId`（search 需显式
  `{}`）。**无参裸链接渲染该 run 的「当前轮」**——对已决当前轮即最终结论（RFC-149
  `ReviewPaneMode='decided'`：决策按钮灰置、批注冻结、结论 chip + 理由可见，
  `lib/review/readonly.ts:31-39`）。「结论回显页」是既有形态，本 RFC 不新造。
- **裸链渲染的「当前轮」= `getReviewDetail` 的 current-version 选择（本 RFC 的判据核心）**：
  - 单文档：`allRows.sort(b.versionIndex - a.versionIndex)[0]`——**最高 versionIndex 版**
    （`review.ts:1174-1177`）。
  - 多文档（RFC-079/142）：pending 成员若有则渲染 pending 轮，否则取最高 reviewIteration
    +最高 roundGeneration 轮，`documents[0]` 为代表（`review.ts:1143-1161`）。
  - ⇒ 裸链**不认「历史上曾有人工结论」**，只认「当前轮」。一行评审在人工决策后又
    re-park 出新 pending 轮时，裸链渲染的是**新 pending 轮**、不是旧结论。
- 评审生命周期（**设计门多轮勘误后的真实事实**，只读依据）：
  - 评审历史挂在 **node_run 行上复用**：doc_versions 按 `review_node_run_id` 归档
    （`db/schema.ts:910-935`），一行 review run 承载多轮 `versionIndex` 递增的版本。
  - approve：同行 `awaiting_review → done`（`services/review.ts:2089`），最高版=approved。
  - reject / iterate：**同行复用**——`awaiting_review → pending` + `reviewIteration+1`
    （`services/review.ts:2293-2300`，RFC-053）。人工决策版 `decidedBy = actor.user.id`
    （本地模式 `LOCAL_DECIDER`，`review.ts:1992`）。上游重跑完成后 scheduler re-park 同一行回
    `awaiting_review` 并 mint 新 pending doc_version（`review.ts:573-586`）——**此刻旧结论版
    被新 pending 版盖成"非当前轮"**。
  - sibling cascade（`review.ts:2460-2513`）：一个评审 reject 会把同上游兄弟评审 pending 版
    标 `rejected` + `decidedBy=SYSTEM_DECIDER`，兄弟行拉回 pending + `reviewIteration+1`。
    ⇒ **`reviewIteration>0` 与「人工决策过」不等价**（系统代决也 iter+1）。
  - **`awaiting_review → 终态-非-done` 可达**：`cancel-by-supersede`（retry-cascade，
    `lifecycle.ts` 转移 + `review.ts:2494`）能把 re-park 后仍挂新 pending 版的评审行置
    `canceled`；`mark-failed`/`mark-interrupted` 亦可。此刻该行「曾有人工结论 v_k」为真、
    但当前轮是新 pending 版 ⇒ **「曾有结论」不能作判据**（R3-high 命中的正是此洞）。
    对照：daemon 重启 orphan-reap（`orphans.ts:47` / `orphanReconcile.ts:85`）只翻
    `running`/`pending`、不碰 `awaiting_review`；`cancelTask`（`task.ts:1197`）要求 task
    pending/running 而停在评审的 task 是 awaiting_review——故常规中断/取消**不**制造该洞，
    唯 supersede 系列制造。
  - 人工/系统决策既有判别原语：`SYSTEM_DECIDER='system'`（唯一系统值）/`LOCAL_DECIDER='local'`
    （本地人工）/`isSystemDecider(x)⟺x==='system'`（RFC-149，`shared/src/schemas/review.ts:174-179`）。
  - 活性不变量：同一时刻每任务至多一条 `awaiting_review` run（`lifecycleInvariants.ts:15-18` T1/U1）。
  - 后端轮次比较器是**纯 ULID id 序**（`pickFreshestRun`/`isFresherNodeRun`，`review.ts:322-341`）。
- **node-runs 响应已有 review 派生字段先例（RFC-078）**：`getTaskNodeRuns`
  （`services/task.ts:2200-2280`）一次性按 task 载入 doc_versions 投影分组到 `versionsByRun`，
  对每行经纯函数 `deriveReviewRoundTiming` 派生 `reviewRoundStartedAt`/`reviewDecidedAt`
  （`schemas/task.ts:688-705` optional）。本 RFC 的新判据字段在**同一栈点**零额外查询派生。
- **`getReviewDetail` 既有潜伏 bug（R2 勘误）**：详情摘要经
  `listReviewSummaries(db,{limit:500})` 再 `.find(nodeRunId)`（`review.ts:1123-1127`），而列表
  limit 是**全局** `doc_versions ORDER BY created_at DESC LIMIT n` **先截断后过滤**
  （`review.ts:1013-1019`）。老任务评审的所有版本一旦跌出全局最新 500 条，裸链 404——本 RFC
  让任意旧节点可直达，必须随行修正。

## 2. 判据：当前轮是否人工结论（单一事实源，Reframe 设计）

核心转变（多轮设计门后的终稿）：判据从「这行**曾经**人工决策过」改为「**裸链会渲染的那一轮**
是人工决策的」。这样 oracle 恰好预言裸链所示内容，杜绝"点 decided、页面却是空 pending 轮"。

### 2.1 共享纯选择器 `selectCurrentReviewRound`（杜绝与 getReviewDetail 漂移）

把 `getReviewDetail` 挑「当前渲染轮」的逻辑抽成**泛型**纯函数，返回**行本身**（代表行 + 多文档
成员列表），让 `getReviewDetail` 能直接用返回的行渲染（保住 id/bodyPath/itemIndex），判据
stamping 读同一代表行 —— 二者真正同源、无第二份选择逻辑（R4-high 修：只返回 `{decision,
decidedBy}` 会丢行身份、逼 getReviewDetail 另挑一次而复活 fork）：

```ts
// packages/shared/src/schemas/review.ts（与 isSystemDecider 同居）
/** 裸链 /reviews/{run} 当前渲染的那一轮。泛型透传行的全部字段（id/bodyPath/…）。
 *  single：代表 = 含 superseded 的最高 versionIndex 版，members = [代表]；
 *  multi：pending 成员优先、否则最高 reviewIteration+roundGeneration 轮的成员集，
 *         代表 = 成员按 itemIndex 升序的首个。镜像 getReviewDetail:1143-1177。空行集 → null。 */
export interface CurrentReviewRound<T> { representative: T; members: T[] }
export function selectCurrentReviewRound<
  T extends {
    versionIndex: number; decision: DocVersionDecision; decidedBy: string | null
    itemIndex: number | null; roundGeneration: number | null; reviewIteration: number
  },
>(rows: readonly T[]): CurrentReviewRound<T> | null

/** 当前轮是否人工结论：代表行 decision∈{approved,rejected,iterated} ∧ !isSystemDecider(decidedBy)。
 *  null / pending / superseded / 系统代决 → false。 */
export function isHumanReviewConclusion(
  representative: { decision: DocVersionDecision; decidedBy: string | null } | null,
): boolean
```

`getReviewDetail` 重构为**唯一调用点**：`const round = selectCurrentReviewRound(allRows)`，
single 取 `round.representative` 读正文，multi 用 `round.members` 装 `documents[]` +
`round.representative` 作 `currentVersion`/body。行为保持——既有 review 测试 + 一条
`detail.currentVersion.id === selectCurrentReviewRound(rows).representative.id` 对拍锁定
（single / multi / superseded-top 三态）。判据 stamping：
`isHumanReviewConclusion(selectCurrentReviewRound(versionsByRun[runId])?.representative ?? null)`。

> **实现陷阱（勿复用错的既有选择器）**：single-doc 必须**含 superseded** 取最高 versionIndex
> ——镜像 `getReviewDetail` 的 `allRows.sort(b.versionIndex-a.versionIndex)[0]`，**不是**
> `deriveReviewRoundTiming` 的「最高**非** superseded 版」。二者在 superseded-top 瞬窗分叉：
> 若渲染的最高版是 superseded（系统），判据必须随之判 false（当前轮无人工结论、不可点），
> 用非-superseded 版会让判据谎报 human。getReviewDetail 直接调同一函数从根上杜绝分叉。

### 2.2 服务端 stamping `reviewNavKind`（后端一处算全评审语义）

判据的**可点击性 + awaiting/decided 分类**全由后端一处算定，因为「可渲染」这一必要条件只有
后端看得到 doc_versions（前端只有 NodeRun 字段）。`getTaskNodeRuns`（`services/task.ts`）现有
dv 投影仅 `{reviewNodeRunId, createdAt, versionIndex, decision, decidedAt}`（`task.ts:2210-2217`，
RFC-078 用）；`selectCurrentReviewRound` 还需 `decidedBy`（人工判据）+ `itemIndex` /
`roundGeneration` / `reviewIteration`（多文档轮选择）——**投影补这 4 列**（`reviewIteration` 是
每-doc 的、**不是** node_run 的，多文档 no-pending 分支按 doc.reviewIteration 挑最新轮，误用
node_run.reviewIteration 会与 getReviewDetail 分叉）。每个 review run 派生：

```ts
const round = selectCurrentReviewRound(versionsByRun[run.id] ?? [])
let reviewNavKind: 'awaiting' | 'decided' | null = null
if (round !== null) {                               // 有可渲染当前轮（getReviewDetail 不会 404）
  if (run.status === 'awaiting_review') {
    // 'awaiting' 额外要求代表版是 PENDING：重开的空 list 评审 park awaiting 却不建新版本
    // （review.ts:688-700），代表版是旧已决行——点它开的是旧轮而非空的当前轮 ⇒ 判 null。
    if (round.representative.decision === 'pending') reviewNavKind = 'awaiting'
  } else if (isHumanReviewConclusion(round.representative)) {
    reviewNavKind = 'decided'
  }
}
```

stamp `NodeRunSchema.reviewNavKind: z.enum(['awaiting','decided']).nullable().optional()`
（紧邻 RFC-078 双字段，注释注明 RFC-158 与派生语义；无 migration——读时派生）。非评审行、
无 doc_version 的行（**含空 `list<md>` review 的 awaiting-零版本**）自然为 null。

**关键：`round !== null` 前置门**——空 `list<markdown>`/`list<path<md>>` 上游会让评审 park
`awaiting_review` 却**不建任何 doc_version**（`review.ts:688-700`），`getReviewDetail` 遇零版本
抛 404（`review.ts:1133-1135`）。只判 `status==='awaiting_review'` 会把这种节点标成可点却跳
404（R5-high）。`round === null` ⟺ 该 run 无 doc_version ⟺ 裸链必 404 ⇒ 一律 null 不可点。
（旁注：node-runs 表既有「评审」按钮对空评审同样 404，是**先于本 RFC 的既有 bug**；本 RFC
不扩大它、也不在此顺修——canvas 侧严格不制造新 404 即达标，空评审页首类化留作后续 RFC。）

**配套：让「有 doc_version ⟹ getReviewDetail 可渲染」真成立**——`getReviewDetail` 的**单文档**
路径直接 `body = readDocVersionBody(...)` **无 try/catch**（`review.ts:1186`），body 文件缺失时
抛 `doc-version-body-missing`（`review.ts:958-962`）；而**多文档**路径已 try/catch 兜底
`body=''`（`review.ts:1170-1174`）。这条不对称让「`round!==null` ⟺ 不 404」在单文档 body 文件
被 GC/清理后不成立。§4.5-c 把单文档 body 读取对齐多文档的 `body=''` 兜底（3 行镜像），使
`reviewNavKind!==null` 严格蕴含「裸链可渲染」；顺带修单文档 body-missing 的既有 404（表按钮同益）。

### 2.3 前端推导 `deriveReviewNodeNav`（freshest-run 编排）

后端已把评审语义算成 `reviewNavKind`，前端只挑「节点当前态」= **最新（ULID 最大）top-level 行**，
读它一行的 stamp（无状态/人工/渲染判断）：

```ts
export type ReviewNodeNavKind = 'awaiting' | 'decided'
export interface ReviewNodeNav { kind: ReviewNodeNavKind; nodeRunId: string }

/** 任务画布 review 节点的点击目标：
 *  1. 只看该 nodeId 的 top-level 行（parentNodeRunId == null，镜像后端 topLevelOnly）。
 *  2. 取其中 ULID 最新（later-minted-wins，镜像 isFresherNodeRun）的一行=节点当前态。
 *  3. 该行 reviewNavKind==='awaiting'→awaiting；'decided'→decided；null/缺席→不可点。
 *  字段缺席（旧 daemon）严判 === 字面量 ⇒ 不可点。 */
export function deriveReviewNodeNav(runs: NodeRun[], nodeId: string): ReviewNodeNav | null
```

> **实现门勘误（Codex medium，已修）**：初版按「先滤 awaiting、再滤 decided 取 ULID 最新」编排，
> 会让一条**更新的 null 行**（如 R3 re-park-then-supersede：当前态不可点）无法遮蔽同节点的**更旧
> decided 行**——画布仍标可点并跳到过期结论。修正=freshest-run：节点当前态=最新 top-level 行，
> 只读它的 stamp。awaiting 与 decided 共存时 awaiting 恒为更新行（US-2 再评审在旧决策之后铸造），
> 故 freshest-run 天然优先 awaiting、无需特例。

逐场景验证 stamp 与「裸链所示 / 可渲染」一致（无空 decided 视图、无 404 可点）：

| run 形态（当前轮代表版 / 版本集） | `reviewNavKind` | 分类 | 裸链渲染 |
|---|---|---|---|
| done，当前版=approved（人工） | decided | decided | approved 结论 ✓ |
| pending/running，当前版=iterated/rejected（人工，打回重跑窗口，尚未 re-park） | decided | decided | 该人工结论 ✓（主故事 3） |
| canceled/interrupted，当前版=人工 iterate/reject（未 re-park） | decided | decided | 该人工结论 ✓ |
| awaiting_review，有 pending 版（含 re-park 后 v2） | awaiting | awaiting（freshest 行） | 新一轮交互 ✓ |
| **awaiting_review，零 doc_version（首轮空 `list<md>` review）** | **null** | **null（不可点）** | —— ✓（R5 修：不跳 404） |
| **awaiting_review，代表版=旧已决行（重开空 list、无新 pending）** | **null** | **null（不可点）** | —— ✓（实现门②修：不点开旧轮） |
| canceled(cancel-by-supersede)，当前版=新 pending（re-park 后被 supersede） | null | null | —— ✓（R3 修：不空 decided） |
| sibling cascade 拉回，当前版=系统 rejected（SYSTEM_DECIDER） | null | null | —— ✓（R2a 修） |
| pending/running/failed/skipped/canceled 无人工当前轮 | null | null | —— ✓ |
| 字段缺席（旧 daemon） | undefined→严判 | null | —— ✓ |

> 勘误史（设计门六轮 7 high + 1 medium + 实现门 2 medium，全折）：
> R1-high：初稿把 reject/iterate 误设为「supersede 旧行+mint 新行」、decided 判
> `done ∨ supersededByReview`——真实是同行复用回 pending，打回重跑窗口误判不可点。
> R2a-high：中稿改 `reviewIteration>0` 补洞，但 sibling cascade 系统代决同样 iter+1——从未
> 人工评审的兄弟行会被误标可点。
> R2b-high：「裸链恒可渲染」被 `getReviewDetail` 全局 limit-500 截断击穿（§4.5-b 随行修）。
> R3-high：改 `hasHumanReviewDecision`（曾经人工）仍不够——一行人工决策后 re-park 新 pending 轮
> 再被 supersede 置 canceled 时，「曾经人工」真但裸链渲染新 pending 轮，点 decided 得空视图。
> R4-high：只返回 `{decision,decidedBy}` 丢行身份、getReviewDetail 没法真调用它 → fork 复活；
> 改泛型 `selectCurrentReviewRound<T>→{representative,members}` 透传行本身。
> R5-high：只判 `status==='awaiting_review'` 会把空 `list<md>` 的零版本 awaiting 标可点却
> 404 → 加 `round !== null` 前置门，评审语义整体下沉后端一处算 `reviewNavKind`。
> R6-high：`round!==null` 仍不严格蕴含「不 404」——单文档 body 文件缺失时 `readDocVersionBody`
> 抛 `doc-version-body-missing`（多文档已兜底）→ §4.5-c 单文档 body 读取对齐 `body=''`。
> R6-medium：`getTaskNodeRuns` 投影漏 per-doc `reviewIteration`（选择器多文档 no-pending 分支需要，
> 误用 node_run.reviewIteration 会分叉）→ 投影补 4 列（§2.2）。
> 实现门-medium①：前端「先滤 awaiting 再滤 decided」编排让更新的 null 行遮不住更旧 decided 行
> （R3 状态点旧结论）→ 改 freshest-run（§2.3）。
> 实现门-medium②：`awaiting` 只判 `round!==null` 会把**重开的空 list 评审**（awaiting_review 但
> 无新 pending、代表版是旧已决行）标可点、点开旧轮 → `awaiting` 加 `代表版.decision==='pending'`
> 前置（§2.2），空当前轮回落 null（同首轮 R5）。
> **终稿**：判据= §2.1 共享选择器（与 getReviewDetail 同源）+「有可渲染当前轮」门（含 body 兜底）
> + 当前轮人工结论，三者在后端一处算成 `reviewNavKind`，前端 freshest-run 读节点当前态；恰好预言裸链所示与可达性。

裸链回显/可达正确性（对源码验证）：`reviewNavKind !== null` ⟺ `round !== null`（有 doc_version、
getReviewDetail 不 404）∧（awaiting 或代表版人工决策）；getReviewDetail 用**同一选择器**渲染同一
代表版 ⇒ 点 awaiting 必有页、点 decided 必是该人工结论（§4.5-b 修后不受全局截断影响）。

## 3. 接线（tasks.detail.tsx）

`TaskStatusCanvas`（同文件 `:631`）内：

1. 新 memo：
   - `reviewNodeIds`: 从 `definition.nodes` 收 `kind === 'review'` 的 id 集。
   - `reviewNavByNode: Map<string, ReviewNodeNav>`：对每个 review id 跑 `deriveReviewNodeNav(runs, id)`。
   - `reviewNavs: Record<string, ReviewNodeNavKind>`：投影给画布做提示（见 §4）。
   `runs` 查询已被 `useTaskSync` 的 WS invalidation 驱动，三态随评审推进自动刷新。
2. `onSelect` 增加 review 分支（置于既有 drawer 映射**之前**）：

```ts
onSelect={(sel) => {
  if (sel === null || sel.kind !== 'node') { onSelectNodeRun(null); return }
  if (reviewNodeIds.has(sel.id)) {
    // review 节点永不进 drawer；先释放 xyflow 选中（重置 lastEmittedSelectionSig），
    // 否则"已选中节点再点被吞"：灰节点点一次没反应、变琥珀后再点就死了
    // （同 tasks-detail-drawer-close-reclick 锁定的 wedge 的画布内镜像）。
    canvasRef?.current?.clearSelection()
    onSelectNodeRun(null)
    const nav = reviewNavByNode.get(sel.id)
    if (nav !== undefined) {
      void navigate({ to: '/reviews/$nodeRunId', params: { nodeRunId: nav.nodeRunId }, search: {} })
    }
    return
  }
  const runId = latestRunByNode.get(sel.id)
  onSelectNodeRun(runId ?? null)
}}
```

3. 类型调整一处：`TaskStatusCanvas` 的 `canvasRef` prop 从 `React.Ref<WorkflowCanvasHandle>`
   改为 `React.RefObject<WorkflowCanvasHandle | null>`——分支内要读 `.current` 调
   `clearSelection`；调用方 `useRef` 产出的就是这个类型，对 `<WorkflowCanvas ref={...}>`
   赋值依旧兼容。既有锁 `tasks-detail-drawer-close-reclick.test.ts` 钉了旧类型字面量，
   锚点随之更新（意图不变且加强：现在两个调用方依赖 handle）。
4. `TaskStatusCanvas` 内新增 `useNavigate()`（文件现只 import `Link`）。
5. drawer 关闭语义顺带成立：review 分支恒 `onSelectNodeRun(null)`——drawer 开着时点
   review 节点 = 关 drawer（+ 跳转或无事）。

时序说明：`clearSelection()` 在 `onNodeClick` 内同步调用是安全的——xyflow 的选中处理先于
`onNodeClick` 完成，`unselectNodesAndEdges()` 只是随后的一次 store 更新，且
`onSelectionChange` 路径本就不 emit `onSelect`（`WorkflowCanvas.tsx:1281-1287`）。
若实现期发现 xyflow 版本行为有出入，退路是包一层 `queueMicrotask`（设计上不预置）。

## 4. 画布提示（可点击性 affordance）

沿 `questionCounts` / `clarifyDirectives` 的既有三件套模式（golden-lock：不传 = 字节不变）：

1. `WorkflowCanvas` 新可选 prop `reviewNavs?: Record<string, 'awaiting' | 'decided'>`：
   - 新 `externalReviewNavsRef` guard + def-sync effect 的 changed 检测与 deps
     （`WorkflowCanvas.tsx:328-424` 现有三镜像旁添加第四个）。
   - `toFlowNodes` 增参并在两个调用点透传（初始 `useState` `:313` + def-sync effect `:391`），
     `__testToFlowNodes` 测试钩子（`:2029-2058`）同步扩参；函数内
     `if (n.kind === 'review' && reviewNavs !== undefined) data.reviewNav = reviewNavs[n.id]`。
2. `CanvasNodeData` 新字段 `reviewNav?: 'awaiting' | 'decided'`（`nodes/types.ts`，注释注明
   仅任务画布填充、编辑器恒 undefined）。
3. `ReviewNode.tsx`：`data.reviewNav` 存在时
   - 根 div 加 `data-review-nav={data.reviewNav}`；
   - 末尾渲染提示行 `<div className="canvas-node__review-nav">{t(key)}</div>`，
     key = `reviewNode.navAwaiting`（点击打开评审）/ `reviewNode.navDecided`（点击查看最近评审结论）。
   - undefined → 两者都不渲染（编辑器像素零变）。
4. `styles.css` 命名空间内最小追加：
   `.canvas-node--review[data-review-nav] { cursor: pointer; }` +
   `.canvas-node__review-nav`（muted 小字，对齐 `.canvas-node__input-source` 的排版尺度）。
5. i18n：`reviewNode.navAwaiting` / `reviewNode.navDecided` 两语种四条（zh-CN.ts / en-US.ts
   既有 `reviewNode` 块内追加）。

「decided 但节点灰色（打回重跑 / 未 re-park 的终态人工结论）」正是提示行存在的理由：可点击性
不能从 `data-status` 推出，必须独立通道。

## 4.5 后端最小改动（两处，随行修一个既有潜伏 bug）

- **(a) 判据下沉 + stamp**（§2.1/§2.2）：shared 加 `selectCurrentReviewRound` /
  `isHumanReviewConclusion`；`getReviewDetail` 的 single/multi current 选择重构为调用前者
  （行为保持，消 fork）；`getTaskNodeRuns` dv 投影 +4 列（decidedBy·itemIndex·roundGeneration·reviewIteration）、每行 stamp
  `reviewNavKind`（有可渲染当前轮门 + awaiting/decided 分类，一处算全）。零额外查询、零 migration。
- **(b) `getReviewDetail` 摘要按 runId 直建**：把 `listReviewSummaries` 循环体里的
  单行摘要构造抽成纯拼装 helper（run+task+wf+nodeMeta+该 run 的 per-port 最新版选择），
  detail 直接按 `nodeRunId` 取数构造，不再经全局 `limit:500` 列表 `.find`。
  列表路径复用同一 helper（消 fork），对外行为不变；**修复**：老评审版本跌出全局最新
  500 条后详情 404 的潜伏 bug（收件箱历史链接同受益）。`listReviewSummaries` 本身的
  列表语义（全局最新 N 条）不在本 RFC 范围内改动。
- **(c) 单文档 body 读取兜底**：`getReviewDetail` 单文档 `body = readDocVersionBody(...)` 包
  try/catch → `body=''`（镜像同函数多文档路径），让「有 doc_version ⟹ 可渲染」严格成立
  （§2.2 论证）；顺带修单文档 body-missing 既有 404。
- 调度 / 决策 / 广播 / ACL 全不动。

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| `nodeRuns` 查询未返回 / 失败 | `runs=[]` → 全部 review 节点不可点（与现状 drawer 也打不开一致），WS/refetch 恢复后自愈 |
| 导航目标 run 被并发决策推进（点击瞬间 awaiting → done / → pending） | 同行复用 ⇒ 目标 id 不变；`reviewNavKind` 随 WS 刷新；评审页按最新 detail 渲染，无空视图 |
| 打回重跑窗口（run=pending/running、当前版=人工 iterate，未 re-park） | `reviewNavKind='decided'` → decided 导航；裸链渲染该人工结论（§2.3 论证）——主故事 3 正命题 |
| re-park 后被 supersede 置 canceled（当前版=新 pending） | `reviewNavKind=null` → 不可点（R3 修：不再导航到空 decided 视图） |
| sibling cascade 拉回的兄弟行（当前版=系统 rejected） | `reviewNavKind=null` → 不可点（R2a 修） |
| **空 `list<md>`/`list<path<md>>` review：awaiting 但零 doc_version（首轮）** | `round=null` ⇒ `reviewNavKind=null` → 不可点（R5 修：不跳 404；空评审页首类化留后续 RFC） |
| **重开空 list review：awaiting 但代表版=旧已决行（无新 pending）** | `代表版.decision!=='pending'` ⇒ `reviewNavKind=null` → 不可点（实现门②修：不点开旧轮） |
| 老任务评审跌出全局最新 500 条 doc_versions | §4.5-b 修后详情按 runId 直取，恒可渲染（回归测试锁定） |
| awaiting 行在 park 与首个 createDocVersion 之间遭 daemon 崩溃（无版本、极窄窗口） | `round=null` ⇒ 不可点（同空评审门，无 404）；resume 的 find-or-create 自愈后恢复可点 |
| 非成员只读 viewer | 能看任务 ⇒ `GET /api/reviews/*` 同 `canViewTask` 门槛（`routes/reviews.ts:85-103`），页面可读；写操作页内自禁 |
| review 在 loop 内多迭代 | 跨 iteration 全量参与 ULID 排序，当前轮人工结论行胜出 |
| multi-doc 评审（RFC-079/142） | `selectCurrentReviewRound` 多文档分支与 getReviewDetail 同源；无差别 |
| 旧 daemon + 新前端（字段缺席） | `reviewNavKind` 严判 `=== 'awaiting'/'decided'` ⇒ 全部按不可点处理，无误导航 |
| 浏览器返回 | 画布 fresh mount，无残留选中/签名 |

## 6. 测试策略（随改动必落；画布接线用源码锁——happy-dom 驱不动 xyflow 真点击，见 canvas-edge-changes.test.ts 注释）

**shared**（`packages/shared/tests/`）：
1. `selectCurrentReviewRound` 矩阵：单文档 `representative`=最高 versionIndex（**含
   superseded-top**）、`members=[representative]`；多文档 pending 成员优先、否则最高
   iteration+generation 轮成员集、`representative`=itemIndex 升序首个；空 → null。断言透传行
   身份（返回的就是输入行对象）。
2. `isHumanReviewConclusion(representative)`：approved/rejected/iterated × decidedBy∈{user-id,
   LOCAL_DECIDER, SYSTEM_DECIDER, null}；pending / superseded / null → false。

**backend**（`packages/backend/tests/rfc158-*.test.ts`）：
3. `getTaskNodeRuns` stamping `reviewNavKind`：awaiting+有 pending 版 → 'awaiting'；
   **awaiting+零 doc_version（空 list review）→ null**（R5 反例先红后绿）；人工 iterate 后
   当前版=iterated 同行（未 re-park）→ 'decided'；**re-park 出新 pending 版后被 supersede
   置 canceled → null**（R3 反例先红后绿）；sibling cascade 系统代决 → null；approve done
   → 'decided'；非评审行 → null；旧数据无 dv → null。
4. `getReviewDetail` × `selectCurrentReviewRound` 同源对拍：`detail.currentVersion.id ===
   selectCurrentReviewRound(allRows).representative.id`（single / multi / superseded-top 三态；
   multi 另断言 `documents` 成员集 == `round.members`）。
5. `getReviewDetail` 截断回归：插入 501 条更新的 doc_versions 后，老评审 run 详情仍 200
   且 currentVersion 正确（修复前 404，先红后绿）；列表路径行为不变（同 helper 拼装对拍）。
5b. `getReviewDetail` 单文档 body 文件缺失 → 200 + `body=''`（修复前抛 doc-version-body-missing，
   先红后绿）；多文档缺失路径行为不变。

**frontend**（`packages/frontend/tests/review-node-click-nav.test.tsx`）：
6. `deriveReviewNodeNav` 矩阵（≥12 case，纯 ULID 编排 over `reviewNavKind`）：无 runs→null；
   全 `reviewNavKind=null`→null；单行 `'awaiting'`→awaiting 目标；`'awaiting'` 优先于任何
   `'decided'` 行；单行 `'decided'`→decided；多 `'decided'` 行取 ULID 最新（id 序构造）；
   多 `'awaiting'`（U1 违例防御）取 ULID 最新；`parentNodeRunId` 非空子行忽略；跨 nodeId 不
   串扰；字段缺席（undefined）→ 严判排除 → null。
7. ReviewNode 渲染三态：`reviewNav:'awaiting'` → 提示文案（i18n key 解析）+
   `data-review-nav="awaiting"`；`'decided'` 同理；undefined → 无提示行、无 data 属性
   （编辑器 golden-lock 的组件级证明）。
8. 接线源码锁（`tasks.detail.tsx`）：review 分支存在且先于 `latestRunByNode` 映射；
   分支内 `clearSelection()` 先于 `navigate`；navigate 目标 `/reviews/$nodeRunId` 且带
   `search: {}`；`onSelectNodeRun(null)` 在分支内出现（drawer 永不为 review 打开）。
9. 注入链行为测试 + 少量源码锁：经既有 `__testToFlowNodes` 钩子（扩参后）断言——传
   `reviewNavs` 时 review 节点 data 带 `reviewNav`、非 review 节点不染、不传时字段缺席；
   源码锁兜底 effect deps 含 `reviewNavs`；（`styles.css`）`[data-review-nav]` cursor 规则
   存在；（i18n）双语四 key 存在。

**既有锁迁移盘点**（feedback_grep_locks_before_push，实现前再全量 rg 复核一遍）：

- `tasks-detail-drawer-close-reclick.test.ts`：`canvasRef\?: React\.Ref<WorkflowCanvasHandle>`
  一条 regex 锚点 → RefObject 形态。其余断言（closeNodeDrawer 顺序、ref 转发）不动、必须保绿。
- `NodeRunSchema` / node-runs 响应形状的全字段锁（如有，参照 RFC-157 的 rfc103 锁先例）随
  `reviewNavKind` 增列更新。
- `getReviewDetail` / `listReviewSummaries` 既有测试（`review-summary-*` 等）在 helper 抽取后
  必须零行为变更保绿（对拍锁定）。
- `awaiting-node-highlight.test.tsx` / `canvas-chip-icon-and-label.test.tsx` /
  `canvas-review-output-drag*.test.*`：渲染 ReviewNode 但都不传 `reviewNav` → 走 undefined
  分支，预期零适配（若因 DOM 追加断言失败，修断言语义而非绕开）。
- e2e：`review.spec.ts` 是 API 驱动、`visual-regression` 8 页不含任务详情画布 → 双零影响。

## 7. 耦合点清单

| 触点 | 改动 |
|---|---|
| `shared/src/schemas/review.ts` | `selectCurrentReviewRound` + `isHumanReviewConclusion`（居 `isSystemDecider` 旁） |
| `shared/src/schemas/task.ts` | `NodeRunSchema.reviewNavKind?: 'awaiting'\|'decided'\|null`（读时派生，无 migration） |
| `backend services/review.ts` | `getReviewDetail` current 选择改调 `selectCurrentReviewRound`（消 fork）+ 摘要按 runId 直建 + 摘要拼装 helper 抽取（list 复用）+ 单文档 body 读取 try/catch 兜底 |
| `backend services/task.ts` | `getTaskNodeRuns` dv 投影 +4 列（decidedBy·itemIndex·roundGeneration·reviewIteration）、每行算 `reviewNavKind`（round 门 + 状态 + 人工判据一处算全） |
| `lib/review-node-nav.ts`（新） | 纯 ULID 编排 over `reviewNavKind` |
| `routes/tasks.detail.tsx` | TaskStatusCanvas：navigate + 两 memo + onSelect 分支 + canvasRef 类型 |
| `components/canvas/WorkflowCanvas.tsx` | `reviewNavs` prop + ref-guard + `toFlowNodes` 注入 |
| `components/canvas/nodes/types.ts` | `CanvasNodeData.reviewNav` |
| `components/canvas/nodes/ReviewNode.tsx` | data 属性 + 提示行 |
| `styles.css` | `.canvas-node--review[data-review-nav]` cursor + `.canvas-node__review-nav` |
| `i18n/zh-CN.ts` / `en-US.ts` | `reviewNode.navAwaiting` / `navDecided` |
| 调度 / 决策流 / 广播 / ACL / migration | **零改动** |
