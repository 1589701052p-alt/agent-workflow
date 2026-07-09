# RFC-161 任务画布反问节点点击直达反问页 — design

本 RFC 是 RFC-158（评审节点点击直达）的**姊妹镜像**，架构模式逐点复用，反问域**显著更简单**：前端推导
**纯 freshest-run，与评审 `deriveReviewNodeNav` 同形**（设计门两轮否决了初稿的「awaiting 优先」分片优化），
后端判据**收敛**为一个纯映射（无 RFC-158 的共享泛型选择器）+ 一个孤儿-awaiting 抑制 gate。

## 1. 现状与依据（文件:行号）

- **画布点击 → drawer**：`tasks.detail.tsx:800-825` `WorkflowCanvas.onSelect`。RFC-158 已在其中加了
  **review 分支**（`:810-822`：`reviewNodeIds.has(sel.id)` → `clearSelection()` → `onSelectNodeRun(null)`
  → 条件 `navigate('/reviews/$nodeRunId')`）。反问节点今天走 `:823-824` 的 `latestRunByNode` 映射 →
  `setSelectedNodeRunId` → 打开近乎全空的 drawer。
- **点击派发与吞点击 wedge**：同 RFC-158——xyflow 对已选中节点的 click no-op；解药是命令式
  `canvasRef.current.clearSelection()`（`WorkflowCanvas.tsx` `unselectNodesAndEdges()` + 签名重置）。
  RFC-158 已把 `TaskStatusCanvas` 的 `canvasRef` 改成 `React.RefObject<WorkflowCanvasHandle | null>`
  （`tasks.detail.tsx:639-641`），本 RFC 复用，**不再改类型**。
- **反问页**：`routes/clarify.detail.tsx`，路由 `path: '/clarify/$nodeRunId'`（**无 search 要求**——
  既有表格「去回答」`<Link to="/clarify/$nodeRunId" params={{nodeRunId: r.id}}>` 不带 search，
  `tasks.detail.tsx:932-935`）。`readonly = s.status !== 'awaiting_human'`（`clarify.detail.tsx:673`）——
  **同一页面既渲染 awaiting 可交互表单，也渲染 answered/abandoned 只读回显**（sealed 时用提交答案 pre-fill
  表单，`:259-269`），故「回显页」是既有形态，本 RFC 不新造。
- **裸链渲染的「最新轮」= 判据核心**：`getClarifyRoundDetail(db, intermediaryNodeRunId)`
  （`services/clarifyRounds.ts:195-214`）取 `where(intermediaryNodeRunId).orderBy(desc(createdAt)).limit(1)`
  ——取该 node_run 的**最新一轮**（**本 RFC 不改它**；判据 stamp 用同选法 createdAt-max，best-effort 对齐标签；
  安全属性只需「有 round ⟹ 不 404」，与选轮无关，见 §4.5）。无匹配行 → `NotFoundError('clarify-round-not-found')`（`:206-211`）；
  路由层若连 node_run 都不存在则 `clarify-session-not-found`（`routes/clarify.ts:69-80`）。⇒ 裸链**只认
  最新轮**，且**无 round 必 404**。
- **反问 run 生命周期（只读依据，源码验证）**：
  - `createClarifySession`（`services/clarify.ts:120-230`）：agent 发问时 runner 调用，**每次都 INSERT 新的
    `clarify_sessions` + `clarify_rounds` 行**（`:185-230`）。node_run 复用规则：
    `findClarifyNodeRunForShard(taskId, clarifyNodeId, shardKey, iteration)` 命中则复用该 node_run（并把
    非 awaiting 的它 `park-human` 回 awaiting，`:151-161`），否则 `mintNodeRun(cause:'clarify-park',
    status:'awaiting_human', shardKey, parentNodeRunId)`（`:162-178`）。
  - ⇒ **一个 clarify node_run 可承载多个 round**（re-park 追加新 round，同 `intermediaryNodeRunId`、
    不同 `createdAt`）；`getClarifyRoundDetail` 取最新那条 ⇒ **判据映射也必须 by-createdAt 取最新**
    （非防御、是真实 re-park 场景）。
  - **封存**：`clarifySeal.ts:384` 提交答案时**原子**把 node_run `awaiting_human → done` 且 round
    `awaiting_human → answered`（同 `dbTxSync`）。⇒ answered round ⟺ node_run `done`。
  - **分片自反问**：agent-multi 上游按 shard 分别调 createClarifySession → **同一 clarifyNodeId 有多个
    node_run**（每分片一个，各自 `shardKey`、各自 awaiting round）。反问页 shard switcher 用
    `p.intermediaryNodeRunId` 在兄弟分片间切换（`clarify.detail.tsx:766-785`）。
  - **round 终态**：`clarify_rounds.status ∈ {awaiting_human, answered, canceled, abandoned}`
    （`db/schema.ts:1244-1248`）。`canceled` 仅 kind=self（RFC-023 任务取消路径）；`abandoned` 仅 kind=cross
    （RFC-053 CR-1 父任务失败）。
  - **无 round 的反问 node_run**：cross-clarify 的 scheduler guard 行（`cross-clarify-guard`）：
    `dispatchCrossClarifyNode` 命中 persistent-stop 时把一条**全新**的 cross-clarify node_run
    **强制 `pending → done`** 却**不建 clarify_round**（`crossClarify.ts:430-446` short-circuit-stop，
    "node_run forced done"）；missing-questioner 失败同类。这类 `done` 行 `intermediaryNodeRunId` 在
    clarify_rounds 里查无 → 判 `null`（不制造 404）。**关键**：它是**全新且更新**的 run（不是复用旧
    answered 行），故它遮蔽同节点更旧 answered run 的责任落在前端 freshest-run（§2.3）。
    （另注：cross reject 等路径会 `DELETE` 该任务的 cross clarify_rounds〔`crossClarify.ts:580`〕——曾
    answered 的 cross run 之后可能变无-round，stamp 随之从 'answered' 翻 `null`，前端照判不可点、不 404，
    因 stamp 每次由当前 DB 现算。）
- **node-runs 响应已有 review 派生字段先例（RFC-158）**：`getTaskNodeRuns`（`services/task.ts:2191-2306`）
  按 task 一次性载入 doc_versions 投影分组，每行 stamp `reviewNavKind`（`:2249-2304`）。本 RFC 在**同一
  函数、同一 map 循环**加一次 clarify_rounds 载入 + 每行 stamp `clarifyNavKind`——一处额外查询、零 N+1、
  零 migration。

## 2. 判据：反问节点当前态（单一事实源）

### 2.1 收敛点：无需共享泛型选择器

RFC-158 review 之所以要泛型 `selectCurrentReviewRound<T>`，是因为「当前轮」在评审域是复杂选择（单文档取
最高 versionIndex 含 superseded / 多文档 pending 优先否则最高 iteration+generation 轮成员集）。反问域的
「最新轮」就是 **by `createdAt` 取最新**（`getClarifyRoundDetail` 的 `desc(createdAt) limit 1`），一行代码，
无分支、无成员集。故本 RFC **不引入**共享选择器，只引入一个**纯映射**（居 `shared/schemas/clarify.ts`，与
`ClarifyRoundStatus` 同源）：

```ts
// packages/shared/src/schemas/clarify.ts
/** RFC-161: 任务画布反问节点点击目标的三态判据。裸链 /clarify/{run} 渲染的是该 run 最新一轮
 *  clarify_round；此映射把该轮状态投影成画布点击语义：
 *    awaiting_human → 'awaiting'（可交互作答页）
 *    answered       → 'answered'（只读回显页）
 *    canceled / abandoned / undefined(无 round) → null（不可点，杜绝跳 404 / 空视图）
 *  与 getClarifyRoundDetail「取最新轮」的选行同源 —— 一处算全可点性 + 分类。 */
export type ClarifyNodeNavKind = 'awaiting' | 'answered'
export function clarifyNavKindForRoundStatus(
  status: ClarifyRoundStatus | undefined | null,
): ClarifyNodeNavKind | null {
  if (status === 'awaiting_human') return 'awaiting'
  if (status === 'answered') return 'answered'
  return null // canceled / abandoned / 无 round
}
```

（`ClarifyRoundStatus = 'awaiting_human' | 'answered' | 'canceled' | 'abandoned'`，`schemas/clarify.ts:357-366`
的统一枚举。）

### 2.2 服务端 stamping `clarifyNavKind`（后端一处算全）

判据的**可点击性 + awaiting/answered 分类**全由后端算定，因为「有可渲染最新轮（不 404）」这一必要条件只有
后端看得到 clarify_rounds（前端 NodeRun 无该表）。`getTaskNodeRuns`（`services/task.ts:2191`）在 dvRows 载入
之后、`runs.map` 之前加一次 clarify_rounds 载入（按 task，走 `idx_clarify_rounds_task`），构建
「node_run id → 最新轮状态」映射（取 createdAt-max，**与 getClarifyRoundDetail 的 `desc(createdAt).limit(1)`
同选法**，§4.5）：

```ts
// dvRows 之后（task.ts:~2232）
const crRows = await db
  .select({
    intermediaryNodeRunId: clarifyRounds.intermediaryNodeRunId,
    status: clarifyRounds.status,
    createdAt: clarifyRounds.createdAt,
  })
  .from(clarifyRounds)
  .where(eq(clarifyRounds.taskId, taskId))
// 每个 intermediaryNodeRunId 取 createdAt-max 那一轮的状态——**与 getClarifyRoundDetail 现有
// orderBy(desc(createdAt)).limit(1) 同选法**（getClarifyRoundDetail 不改）。RFC-161 需要的安全属性只有
// 「stamp 非空 ⟹ 该 run 有 clarify_round ⟹ getClarifyRoundDetail 不 404」——与选哪一轮/tie-break 无关，
// 恒成立。真实多轮=幂等重放（createdAt 秒级相异，createdAt-max 唯一），tie 仅在同 createdAt 的等价重复轮间、
// 与 getClarifyRoundDetail 同为非确定（同类），是 §4.5 划为非目标的既有子系统属性、不为 nav 引入选轮键。
const latestRoundByRun = new Map<string, { status: ClarifyRoundStatus; createdAt: number }>()
for (const cr of crRows) {
  const prev = latestRoundByRun.get(cr.intermediaryNodeRunId)
  if (prev === undefined || cr.createdAt > prev.createdAt) {
    latestRoundByRun.set(cr.intermediaryNodeRunId, {
      status: cr.status as ClarifyRoundStatus,
      createdAt: cr.createdAt,
    })
  }
}
// 判据只需状态：const clarifyRoundStatusByRun = (runId) => latestRoundByRun.get(runId)?.status
```

`runs.map((r) => {...})` 内每行（紧邻既有 `reviewNavKind` stamp）。`getTaskNodeRuns` 顶部已载 `task`
（`task.ts:2192`），据其 status 对**孤儿 awaiting** 加抑制 gate：

```ts
// getTaskNodeRuns 顶部已有 const task = await getTask(db, taskId)
const clarifyTaskDead = task.status === 'canceled' || task.status === 'failed'
// ...runs.map 内：
let clarifyNavKind = clarifyNavKindForRoundStatus(latestRoundByRun.get(r.id)?.status)
// 孤儿 awaiting 抑制（设计门 Codex ②a）：cancelTaskRow/failTask 只翻 task 行、不关 clarify
// round+node_run（scheduler.ts:541-543 / :5596-5611），故 canceled/failed 任务会遗留
// awaiting_human 孤儿轮——死任务不得把反问标成「可作答」。answered 不 gate（任何任务上回看
// 历史都 OK）。
if (clarifyNavKind === 'awaiting' && clarifyTaskDead) clarifyNavKind = null
// ...return { ...(既有字段), reviewNavKind, clarifyNavKind }
```

非反问行、无 round 的行（含空透传 guard 行）`map.get(r.id) === undefined` → `null`。stamp
`NodeRunSchema.clarifyNavKind: z.enum(['awaiting','answered']).nullable().optional()`（紧邻 `reviewNavKind`，
注释注明 RFC-161 与派生语义；**无 migration**——读时派生）。

> **可渲染/可达正确性（对源码验证）**：`clarifyNavKind !== null` ⟹ `clarifyRoundStatusByRun.has(r.id)`
> （该 run 有 clarify_round ⟹ `getClarifyRoundDetail` 不 404）∧ 最新轮 ∈ {awaiting_human, answered}；
> `getClarifyRoundDetail` 用**同源**的「最新轮」渲染 ⇒ 点 awaiting 必有可交互页、点 answered 必是该只读
> 回显轮。canceled/abandoned 虽有 round（不会 404）但判 null——是**有意**不可点（非目标 §3）。
> （注：因孤儿 awaiting gate，`awaiting_human` 最新轮在 canceled/failed 任务上判 null，故上式是**单向蕴含**
> ——`!== null` 恒可渲染，反向不成立；这只让「可渲染却判不可点」的死任务 awaiting 更保守，不破坏「可点必可
> 渲染」的安全侧。）
>
> **孤儿 awaiting gate 边界**：只 gate `canceled`/`failed`（cancelTaskRow/failTask 的孤儿源）；**不 gate**
> `interrupted`（daemon 重启、可 resume 后继续作答，awaiting 合法待答）与 `done`（有 awaiting 反问的任务不可能
> done）。前端 freshest-run 已独立堵住「更新 null 遮蔽 stale awaiting」（Codex ②b），此 gate 仅补「孤儿
> awaiting 自身即 freshest run」的 ②a。

### 2.3 前端推导 `deriveClarifyNodeNav`（纯 freshest-run，与评审同形）

后端已把语义算成 `clarifyNavKind`，前端只挑「节点当前态」= **该 nodeId 的 ULID 最新 run**，读它一行的
stamp——**纯 freshest-run，与 RFC-158 `deriveReviewNodeNav` 同形**（用户要「与评审完全对齐」，这正是评审
的规则）。review 的 freshest-run 之所以稳，是因为它**只认当前 run、绝不伸手到当前态之外**；反问沿用同款、
不做「awaiting 优先」，理由是设计门两轮收敛出的：

- **不用「awaiting 优先」**：初稿曾为分片自反问加「任一 run stamped awaiting 即判 awaiting」，
  但**它会伸手到当前态之外抓一条可能 stale 的 awaiting**——而 stale awaiting **真实可达**：`cancelTaskRow`
  取消任务时**只翻 task 行为 `canceled`、不关 clarify round/node_run**（`scheduler.ts:541-543` abort 分支调
  cancelTaskRow，`:5596-5611` 只 set task 行）⇒ 被取消/后续重试的任务会遗留一条 `awaiting_human` 孤儿
  round+run。若前端「任一 awaiting」优先，就会在存在**更新的 null/guard run**（当前真态）时仍导航到那条
  stale awaiting（设计门 Codex 第 2 轮）——与「更新 null 被更旧行遮蔽」是同一类洞、只在
  awaiting 侧。**freshest-run 从根上免疫**：只读当前 run 的 stamp，更旧的 stale awaiting 永远遮不住更新的
  null。
- **freshest-run 天然满足「更新 null 遮蔽更旧 answered」**（设计门 Codex 第 1 轮）：`dispatchCrossClarifyNode`
  persistent-stop 把**全新** cross-clarify node_run 标 `done` 却不建 round（`crossClarify.ts:430-446`），
  该 run 判 null 且是当前态（ULID/startedAt 最新）；freshest-run 读它 = null ⇒ 不可点。同理 loop 上一轮
  answered、这一轮 canceled → 当前 run null ⇒ null。
  （反问的 `startedAt` = createClarifySession mint 时刻〔clarify.ts:175〕，与 ULID 单调同序、不同 run 间不
  分叉，故 ULID-newest 与画布 `statuses` 的 startedAt-latest 恒指同一 run ⇒ 可点性与节点颜色一致。）
- **孤儿 awaiting 兜底在后端**：canceled/failed 任务的孤儿 awaiting 若恰是 freshest run，纯前端仍会判可点。
  故**后端 stamp 对 canceled/failed 任务抑制 `awaiting`**（§2.2 gate）——这类节点 stamp null，freshest-run
  读到 null ⇒ 不可点。前端 freshest-run + 后端 gate 一起，堵住设计门两轮全部反例。

**分片自反问在 freshest-run 下的行为（文档化，非退化目标）**：clarify 节点点击落到节点的 freshest run。
①刚到达、多分片全 awaiting → freshest 是某 awaiting 分片 → 落该分片作答页，页内 shard switcher（≥2 个
awaiting 分片时渲染）列出其余待答分片。②部分已答、freshest 分片**恰是已答的那个**、另有分片待答 →
落该已答分片的只读页；要到某个仍待答的分片，走页内 shard switcher（≥2 awaiting 时）或「节点运行」表格该
分片行的「去回答」按钮（`shouldShowClarifyJump`，本 RFC 保留为补充入口）。此退化仅出现在「最新分片先被答、
且只剩 1 个待答分片」的少见流程，且有表格按钮兜底；换取的是**零 stale-navigation 洞 + 与评审完全同构**，
判为可接受的 v1 行为（今天点该节点只弹空 drawer、这些都没有）。

```ts
// packages/frontend/src/lib/clarify-node-nav.ts（姊妹于 lib/review-node-nav.ts，同形 freshest-run）
export type ClarifyNodeNavKind = 'awaiting' | 'answered'
export interface ClarifyNodeNav { kind: ClarifyNodeNavKind; nodeRunId: string }

/** 任务画布 clarify / cross-clarify 节点的点击目标，或 null（不可点）。
 *  纯 freshest-run（镜像 deriveReviewNodeNav）：节点当前态 = 该 nodeId 的 ULID 最新 run
 *  （= 画布 startedAt 最新行；clarify startedAt=mint 时刻、与 ULID 单调同序），只读它一行 stamp。
 *  不按 parentNodeRunId 过滤（分片 run 是合法目标，后端 clarifyNavKind stamp 是安全闸）。
 *  不用「awaiting 优先」：那会伸手到当前态之外抓一条可能 stale 的 awaiting（cancelTaskRow
 *  遗留孤儿 awaiting_human round，scheduler.ts:541/5596）→ 有更新 null run 时误导航（设计门
 *  Codex 两轮）。freshest-run 只认当前 run，稳；孤儿 awaiting 由后端 canceled/failed gate 抑制。
 *  clarifyNavKind 缺席（旧 daemon）/ null ⇒ 严判落 null。分片作答说明见 design §2.3。 */
export function deriveClarifyNodeNav(runs: NodeRun[], nodeId: string): ClarifyNodeNav | null {
  const mine = runs.filter((r) => r.nodeId === nodeId)
  if (mine.length === 0) return null
  const freshest = ulidNewest(mine)
  if (freshest.clarifyNavKind === 'awaiting') return { kind: 'awaiting', nodeRunId: freshest.id }
  if (freshest.clarifyNavKind === 'answered') return { kind: 'answered', nodeRunId: freshest.id }
  return null
}
```

（`ulidNewest` = 纯 `r.id` 字符串比较取最大，可复用/镜像 `review-node-nav.ts:35-39`——ULID 字典序即时序。
除「不按 parentNodeRunId 过滤」外，与 `deriveReviewNodeNav` 逐行同构。）

逐场景验证 freshest-run + 后端 stamp 与「裸链所示 / 可渲染 / 画布颜色」一致（无空视图、无 404、无 stale）：

| run 形态（标 freshest = ULID/startedAt 最新 run） | freshest 的 `clarifyNavKind` | `deriveClarifyNodeNav` | 说明 |
|---|---|---|---|
| 单 self-clarify，awaiting | awaiting | awaiting | 可交互 ✓ |
| 单 self-clarify，answered（done） | answered | answered | 只读回显 ✓ |
| loop：iter1 answered + iter2 awaiting（iter2 freshest） | awaiting | awaiting | 本轮可交互 ✓（US-7） |
| 分片自反问：多分片全 awaiting | awaiting（freshest 分片） | awaiting | 落该分片，页内 switcher 覆盖其余 ✓ |
| 分片自反问：多分片全 answered | answered | answered | 只读回显 ✓ |
| 分片混合：freshest 分片仍 awaiting | awaiting | awaiting | 落待答分片 ✓ |
| **分片混合：freshest 分片已 answered、另有分片待答** | answered | **answered（落只读）** | 到待答分片走 switcher〔≥2 awaiting〕/ 表格「去回答」——文档化 v1，§2.3 |
| re-park：同 run 追加新 awaiting 轮（该 run freshest、最新轮 awaiting） | awaiting | awaiting | 本轮可交互 ✓ |
| **prior answered + 更新的 null guard（persistent-stop 标 done 不建 round，guard freshest）** | null | **null** | Codex ①：更新 null 遮蔽旧 answered，停/守卫节点不误标可点 ✓ |
| **stale awaiting（cancel 遗留孤儿）+ 更新的 null guard（guard freshest）** | null | **null** | Codex ②b：freshest-run 只认当前 run，stale awaiting 遮不住更新 null ✓ |
| **canceled/failed 任务的孤儿 awaiting（自身即 freshest）** | null（后端 canceled/failed gate 抑制 awaiting） | **null** | Codex ②a：§2.2 gate → stamp null ✓（不在死任务上邀作答） |
| loop：iter1 answered + iter2 canceled（iter2 freshest） | null | null | freshest=canceled → null（与画布灰色一致）✓ |
| cross persistent-stop 透传 / missing-questioner guard（无 round，单 run） | null | null | 不跳 404 ✓ |
| round=canceled（self 取消轮） / round=abandoned（cross 父失败） | null | null | 有意不可点 ✓（US-6） |
| pending（还没发问，若有 run） | null | null | ✓ |
| 字段缺席（旧 daemon） | undefined | null（严判） | ✓ |
| 跨 nodeId | —— | 只看本 nodeId | 不串扰 |

## 3. 接线（tasks.detail.tsx `TaskStatusCanvas`）

沿 RFC-158 review 三件套模式（`tasks.detail.tsx:759-780` 的 `reviewNodeIds` / `reviewNavByNode` /
`reviewNavs` 旁添加对称的 clarify 三件套）：

1. 新 memo（紧邻 review 三件套）：
   - `clarifyNodeIds`：从 `definition.nodes` 收 `kind === 'clarify' || kind === 'clarify-cross-agent'`
     的 id 集。
   - `clarifyNavByNode: Map<string, ClarifyNodeNav>`：对每个 clarify id 跑
     `deriveClarifyNodeNav(runs, id)`，非 null 才入 map。
   - `clarifyNavs: Record<string, ClarifyNodeNavKind>`：投影给画布做提示（见 §4）。
   `runs` 查询已被 `useTaskSync` 的 WS invalidation 驱动，三态随反问推进自动刷新。
2. `onSelect` 增加 clarify 分支（紧接既有 review 分支之后、`latestRunByNode` 映射**之前**；两 kind 集互斥，
   顺序无关）：

```ts
// review 分支（RFC-158，:810-822）之后：
if (clarifyNodeIds.has(sel.id)) {
  // clarify / cross-clarify 节点永不进 drawer；先释放 xyflow 选中（重置 lastEmittedSelectionSig）
  // 防「已选中节点再点被吞」的 wedge（同 review 分支）；再关 drawer；再条件跳转。
  canvasRef?.current?.clearSelection()
  onSelectNodeRun(null)
  const nav = clarifyNavByNode.get(sel.id)
  if (nav != null) {
    void navigate({ to: '/clarify/$nodeRunId', params: { nodeRunId: nav.nodeRunId } })
    // 注：clarify 路由无 search 要求（既有表格「去回答」Link 亦不带 search），故不传 search:{}。
  }
  return
}
```

3. `useNavigate` / `canvasRef: RefObject` 均由 RFC-158 已就位，**不再新增**。
4. drawer 关闭语义顺带成立：clarify 分支恒 `onSelectNodeRun(null)`——drawer 开着时点反问节点 = 关 drawer
   （+ 跳转或无事）。

> **是否抽公共分支**：review 与 clarify 分支高度对称（clearSelection → onSelectNodeRun(null) → 条件 navigate）。
> 为不改动 RFC-158 刚落地的 review 分支（多人树 / 稳定性），本 RFC**新增平行 clarify 分支**、不做抽取重构；
> 若实现期确认零风险可选做一个本地闭包，但非目标。

## 4. 画布提示（可点击性 affordance）

沿 `reviewNavs` 的既有三件套模式（golden-lock：不传 = 字节不变）：

1. `WorkflowCanvas` 新可选 prop `clarifyNavs?: Record<string, 'awaiting' | 'answered'>`：
   - 新 `externalClarifyNavsRef` guard + def-sync effect 的 changed 检测与 deps（现有
     `externalReviewNavsRef` 等镜像旁添加对称的一个）。
   - `toFlowNodes` 增参并在两个调用点透传（初始 `useState` + def-sync effect），`__testToFlowNodes`
     测试钩子同步扩参；函数内
     `if ((n.kind === 'clarify' || n.kind === 'clarify-cross-agent') && clarifyNavs !== undefined) data.clarifyNav = clarifyNavs[n.id]`。
2. `CanvasNodeData` 新字段 `clarifyNav?: 'awaiting' | 'answered'`（`nodes/types.ts`，注释注明仅任务画布填充、
   编辑器恒 undefined）。
3. `ClarifyNode.tsx` **与** `CrossClarifyNode.tsx`（两者都渲染反问 leaf，都要加）：`data.clarifyNav` 存在时
   - 根 div 加 `data-clarify-nav={data.clarifyNav}`；
   - 末尾（description 之后）渲染提示行
     `<div className="canvas-node__clarify-nav">{t(key)}</div>`，key = `clarifyNode.navAwaiting`（点击回答反问）
     / `clarifyNode.navAnswered`（点击查看反问记录）——**两个渲染器复用同一组 i18n key**（都跳同一反问页）。
   - undefined → 两者都不渲染（编辑器像素零变）。
4. `styles.css` 命名空间内最小追加（镜像 `.canvas-node--review[data-review-nav]` / `.canvas-node__review-nav`，
   `styles.css:4590-4599`）：
   `.canvas-node--clarify[data-clarify-nav], .canvas-node--clarify-cross-agent[data-clarify-nav] { cursor: pointer; }`
   + `.canvas-node__clarify-nav`（muted 小字，同 `.canvas-node__review-nav` 排版尺度）。
5. i18n：`clarifyNode.navAwaiting` / `clarifyNode.navAnswered` 两语种（zh-CN.ts 类型块 + 值块 / en-US.ts 值块，
   既有 `clarifyNode` 块内追加，紧邻 `reviewNode.navAwaiting/navDecided` 先例）。

「answered 但节点已答完（绿色 done）」正是提示行存在的理由：可点击性不能从 `data-status` 推出，必须独立通道
（同 RFC-158 论证）。

## 4.5 「最新轮」选择的作用域与非目标边界（设计门 Codex ③②→④→⑤→⑥ 收敛）

收敛史：③②→⑤ 我曾试图给 stamp+`getClarifyRoundDetail` 加一个共用确定性总序 `(createdAt DESC, id DESC)`
求「stamp==detail 恒选同一轮」；⑥（high）点破关键——**这只对齐了读路径，写路径（`sealRoundQuestions`
`.where(intermediaryNodeRunId).all()[0]`、`autoDispatchClarifyRound` `.where(intermediaryNodeRunId).limit(1)`）
仍按 run 无序取轮**，且给读路径加确定性序反而**拉大**读（确定性最高 id）与写（无序）的差距。**终解=正确划定
作用域**：

- **RFC-161 真正需要的安全属性只有一条**：`clarifyNavKind !== null ⟹ 该 run 有 clarify_round ⟹
  getClarifyRoundDetail 不 404`。这**与选哪一轮、tie-break 无关，恒成立**（stamp 非空 ⟺ 该 run 在
  clarify_rounds 有行）。点击后裸链按 `getClarifyRoundDetail` **实时**渲染当前轮——即便 stamp 的标签
  （awaiting/answered）与之在竞态下短暂不符，也**不 404、不空视图**，且随 WS（§4.6/§4.7）自愈。
- **stamp 与 getClarifyRoundDetail 用同一选法（createdAt-max，均不加 id/iteration tie-break）**，best-effort
  对齐标签；`getClarifyRoundDetail` **不改**（保持 `desc(createdAt).limit(1)`），clarify 只读路径零改动。
- **非目标（既有子系统属性，RFC-161 不触碰）**：一个 clarify node_run 的多轮只来自**并发幂等重放**
  （`findClarifyNodeRunForShard` 按 (node,shard,iterationIndex) 复用 run 再插一轮，clarify.ts:115-118）——
  这些重复轮**幂等（同题）**。在极窄的同-createdAt 竞态下，stamp / detail / 提交-派发（seal/autoDispatch）
  三处各按 run 无 tie-break 取轮，**可能选到不同的重复副本**——但这是**先于本 RFC 的 clarify 子系统属性**
  （写路径的无序 run-keyed 取轮一直如此），RFC-161 **只新增一个读 stamp、不改写路径、不放大它**；且副本同题、
  nav 不 404。**统一"每个 run-keyed 操作（读+写）都用同一确定性选轮 / 提交时 pin 并校验 roundId"是更大的
  clarify 子系统一致性课题，另立 RFC**（Codex ⑥ 的建议在此登记为后续项，不并入本 nav RFC）。
- 不用 `iteration` 当选轮键：复用同 run 的重放轮 iteration 取值相同（按 iterationIndex 匹配复用），无法区分。

## 4.6 前端配套：`useTaskSync` cross-clarify 刷新（设计门 Codex ③①，cross↔self 同等待遇）

反问节点的可点性完全依赖 node-runs 里的 `clarifyNavKind`。`useTaskSync`（`hooks/useTaskSync.ts`）现状：
`clarify.answered` 显式 invalidate `['tasks',taskId,'node-runs']`（self 刷新），但
**`cross-clarify.answered`/`cross-clarify.rejected` 只 invalidate `task-clarify-directives`、且无
`cross-clarify.created` 规则**（`:80-96`）——cross-clarify 的 nav stamp 只能靠相邻 `node.status` 事件
偶发刷新、有滞后窗口（另一打开的任务页会显示陈旧 cross nav）。这与「cross 与 self 同等待遇 + 随反问推进
自动刷新」（proposal §2/§4）冲突。修复：把三个 cross 事件（都带 `nodeRunId`=intermediary run id，
`ws.ts:180-203`）补齐到 `clarify.answered` 同款 invalidation：

```ts
// useTaskSync rules 内（保留既有 directives 刷新，不删——RFC-123 单源 toggle 仍需）
'cross-clarify.created': (msg) => [...clarifyKeys(msg.nodeRunId), ['tasks', taskId, 'node-runs']],
'cross-clarify.answered': (msg) => [
  ...clarifyKeys(msg.nodeRunId), ['tasks', taskId], ['tasks', taskId, 'node-runs'],
  ['task-clarify-directives', taskId], // ← 既有，保留
],
'cross-clarify.rejected': (msg) => [
  ...clarifyKeys(msg.nodeRunId), ['tasks', taskId], ['tasks', taskId, 'node-runs'],
  ['task-clarify-directives', taskId], // ← 既有，保留
],
```

（`clarifyKeys` 已存在，含 clarify detail/list/pending-count + task-questions；本改动让 cross 反问的
canvas nav 与 self 一样即时刷新。`node.status`/`node.event` 的 node-runs invalidation 不受影响。）

## 4.7 后端配套：defer 全量封存补 `node.status` 广播（设计门 Codex ④②）

反问答复有两条通道（`routes/clarify.ts` `/answers`）：**quick**（defer=false，`autoDispatchClarifyRound`
后经 `emitAutoAnswered` 广播 self/cross `clarify.answered` → 全客户端刷 node-runs，`:286-320`）与
**defer 控制通道**（集中作答面板，defer=true，`sealRoundQuestions` 后**直接 return、零广播**，`:233-272`）。
defer **全量封存**时 round→answered、intermediary node_run `awaiting_human→done`（`clarifySeal.ts:382-387`），
但无任何 WS 事件 ⇒ 已打开的任务画布 nav（**及既有的节点颜色**，二者同源 node-runs）滞后到轮询/下个 node
事件才刷新。**关键：即便 stamp 暂陈旧，点击仍安全**——裸链按 `getClarifyRoundDetail` 渲染**当前** answered
只读页，绝不 404、不跳错轮（只是提示行文案暂"可作答"）。修复（补事件驱动刷新，对齐 quick 通道）：

- **后端**：defer 分支在 `sealResult.roundFullySealed === true` 时，对 intermediary node_run 补一个
  `node.status`（status `done`；`node_run` 确实转 done，语义正确）——`useTaskSync` 现有 `node.status` 规则
  即 invalidate `['tasks',taskId,'node-runs']`(+task-questions+directives)、**全客户端** self/cross 通吃，
  无需新事件类型。（`broadcastNodeStatus` 在 scheduler.ts:5545 是同款 `taskBroadcaster.broadcast(TASK_CHANNEL,
  {type:'node.status',...})`，路由处等价 emit 即可；best-effort、失败不影响封存结果。）**仅全量封存**发；
  **部分封存**（round 仍 awaiting_human）不发、nav 维持 'awaiting' 不误翻 answered。
- **前端**：集中作答面板 `CentralizedAnswerDialog` 提交成功 handler 追加 `['tasks',taskId,'node-runs']`
  invalidation（本地即时刷新，兜底 WS 往返；与其已有 clarify/task-questions 失效并列）。

（这是 RFC-128 defer 通道**先于本 RFC 的既有广播缺口**〔节点颜色今天也一样滞后〕；本 RFC 因 nav 依赖 node-runs
而顺带补齐——只加一个既有 `node.status` 事件的 emit，不改封存事务/派发语义。）

## 5. 失败模式

| 场景 | 行为 |
|---|---|
| `nodeRuns` 查询未返回 / 失败 | `runs=[]` → 全部反问节点不可点（与现状 drawer 也打不开一致），WS/refetch 恢复后自愈 |
| 导航目标 run 被并发推进（点击瞬间 awaiting → done） | 同行复用 ⇒ 目标 id 不变；`clarifyNavKind` 随 WS 刷新；反问页按最新 detail 渲染（awaiting→answered 只读），无空视图 |
| re-park / 幂等重放：同 node_run 多轮 | stamp 与 getClarifyRoundDetail 同取 createdAt-max（真实多轮 createdAt 秒级相异，唯一）；安全属性=「有 round ⟹ 不 404」恒成立；同 createdAt 竞态下的选轮不一致=既有子系统属性、非目标（§4.5），nav 仍不 404 ✓ |
| cross-clarify 创建/回答（quick 通道）/拒绝后另一打开的任务页 | `useTaskSync` 补三 cross 事件刷 node-runs（§4.6）→ cross nav stamp 即时刷新，与 self 同等待遇（设计门 Codex ③①）✓ |
| defer 全量封存（集中作答面板，round→answered/node_run→done） | 后端补 `node.status` 广播（§4.7）→ 全客户端经现有 node.status 规则刷 node-runs；面板本地也失效 node-runs；**即便暂陈旧点击仍安全**（裸链渲染当前 answered 只读，不 404）（设计门 Codex ④②）✓ |
| defer 部分封存（round 仍 awaiting_human） | 不发 node.status（round 未 answered）；nav 维持 'awaiting' 不误翻 answered ✓ |
| 分片自反问多分片并发 awaiting | freshest-run 落 ULID 最新分片（awaiting）；页内 shard switcher 覆盖余下（§2.3） |
| 分片混合：freshest 分片已 answered、另有待答分片 | freshest-run 落只读；到待答分片走 switcher〔≥2 awaiting〕/ 表格「去回答」（文档化 v1，§2.3） |
| cross persistent-stop 透传 / missing-questioner guard（无 round） | `map.get(id)=undefined` ⇒ null；即便同节点有更旧 answered，freshest=guard(null) 亦不可点（Codex ②b） |
| **canceled/failed 任务的孤儿 awaiting**（cancelTaskRow 只翻 task 行） | 后端 gate `clarifyTaskDead && awaiting → null`（§2.2）⇒ 不可点（Codex ②a，不在死任务上邀作答） |
| round=canceled / abandoned | 映射有该轮但 `clarifyNavKindForRoundStatus` 判 null → 不可点（有意，非目标 §3） |
| 非成员只读 viewer | 能看任务 ⇒ `GET /api/clarify/*` 同 `canViewTask` 门槛（`routes/clarify.ts:91-114` ensureClarifyVisible）；页面可读，写操作页内自禁 |
| clarify 在 loop 内多迭代 | 各 iteration 独立 run；freshest-run 只认 ULID 最新 run——awaiting→作答、answered→回显、canceled/null→不可点（§2.3） |
| 旧 daemon + 新前端（字段缺席） | `clarifyNavKind` 严判 `=== 'awaiting'/'answered'` ⇒ 全部按不可点，无误导航 |
| 浏览器返回 | 画布 fresh mount，无残留选中/签名 |

## 6. 测试策略（随改动必落；画布接线用源码锁——happy-dom 驱不动 xyflow 真点击）

**shared**（`packages/shared/tests/`）：
1. `clarifyNavKindForRoundStatus` 矩阵：`awaiting_human`→'awaiting'；`answered`→'answered'；
   `canceled`/`abandoned`/`undefined`/`null`→null。
2. `NodeRunSchema.clarifyNavKind` 形状：接受 `'awaiting'|'answered'|null|undefined`；缺省不合成键（同
   `reviewNavKind` 的既有形状锁风格）。

**backend**（`packages/backend/tests/rfc161-*.test.ts`）：
3. `getTaskNodeRuns` stamping `clarifyNavKind`：
   - awaiting self-clarify（node_run awaiting_human + round awaiting_human）→ 'awaiting'；
   - answered self-clarify（提交后 node_run done + round answered）→ 'answered'；
   - **canceled round → null**；**abandoned cross round → null**（反例先红后绿）；
   - **无 round 的反问 node_run（cross guard 透传，intermediaryNodeRunId 查无）→ null**（反例）；
   - **Codex 设计门主场景（后端半）**：同一 cross-clarify 节点两 run——run1 answered（有 round）、run2
     更新且 done 无 round（persistent-stop guard）——`getTaskNodeRuns` 分别 stamp run1='answered'、
     run2=null（前端 `deriveClarifyNodeNav` 组5 据此判 null；两半合锁「更新 null 遮蔽旧 answered」）；
   - **幂等重放：同 node_run 两 round（旧 answered createdAt < 新 awaiting，createdAt 相异）→ 取
     createdAt-max = 'awaiting'**（真实 recency 靠 createdAt，createdAt 相异）；
   - **不 404 安全属性（§4.5）**：任一 stamp 非空的 clarify run → `getClarifyRoundDetail(db, runId)` 不抛
     404（有 round 即可渲染）；不为同 createdAt 竞态构造选轮-一致性测试（§4.5 划为既有子系统属性 / 非目标）；
   - **孤儿 awaiting gate（Codex ②a）**：`task.status='canceled'` 且某 clarify run 最新轮仍 awaiting_human
     → stamp **null**（不是 'awaiting'）；`failed` 任务同理；对照 **`interrupted` 任务的 awaiting → 仍
     'awaiting'**（不 gate，可 resume）、**canceled 任务上的 answered round → 仍 'answered'**（不 gate，历史
     可看）——三反例先红后绿；
   - 非反问行（agent/review/io）→ null；旧数据无 round → null。
4. `getTaskNodeRuns` × `getClarifyRoundDetail` 对拍（createdAt 相异的多轮 run）：stamp 的最新轮状态 ==
   `getClarifyRoundDetail(db, runId).status` 映射后的 navKind（best-effort 标签对齐；同 createdAt 竞态不测——§4.5）。
4c. **defer 全量封存广播（设计门 Codex ④②，§4.7）**：POST `/api/clarify/:id/answers` defer=true 全量封存
   （`sealRoundQuestions.roundFullySealed`）后发一条 intermediary node_run 的 `node.status(done)`——self 与
   cross 各一 case（断言 taskBroadcaster 收到 node.status）；**部分封存不发**（round 仍 awaiting_human，反例）；
   修复前 defer 全量封存零广播、先红后绿。

**frontend**（`packages/frontend/tests/clarify-node-click-nav.test.tsx`）：
5. `deriveClarifyNodeNav` **纯 freshest-run** 矩阵（≥14 case，与 `review-node-click-nav` 的 nav 矩阵同构）：
   无 runs→null；单 'awaiting'→awaiting；单 'answered'→answered；
   **freshest 'awaiting'（含同存更旧 'answered'）→ awaiting**（loop iter2 awaiting freshest / 分片 freshest
   awaiting）；**freshest 'answered'（含同存更旧 'awaiting' 或其它）→ answered**（分片混合 freshest 已答→
   answered，文档化行为）；多 'awaiting' 取 freshest；多 'answered' 取 freshest；
   **freshest 为 null/undefined ⇒ null，遮蔽一切更旧行**（Codex 两轮反例，注释链接 §2.3）：
   ① 更旧 'answered' + 更新 null guard（persistent-stop）→ null；
   ②b **stale 'awaiting' + 更新 null guard → null**（freshest-run 只认当前 run，stale awaiting 遮不住）；
   更旧 'answered' + 更新 null（loop-cancel）→ null；
   跨 nodeId 不串扰；字段缺席严判→null；带 parentNodeRunId 的分片 run **不**被过滤掉（参与推导、可当 freshest）。
6. ClarifyNode **与** CrossClarifyNode 渲染三态：`clarifyNav:'awaiting'` → 提示文案（i18n key 解析）+
   `data-clarify-nav="awaiting"`；`'answered'` 同理；undefined → 无提示行、无 data 属性（编辑器
   golden-lock 的组件级证明）。
7. 注入链 + 源码锁：经既有 `__testToFlowNodes` 钩子（扩参后）断言——传 `clarifyNavs` 时 clarify /
   cross-clarify 节点 data 带 `clarifyNav`、非反问节点不染、不传时字段缺席；源码锁兜底 effect deps 含
   `clarifyNavs`；（`styles.css`）`[data-clarify-nav]` cursor 规则含两 kind 选择器；（i18n）双语两 key 存在。
8. 接线源码锁（`tasks.detail.tsx`）：clarify 分支存在且置于 `latestRunByNode` 映射之前；分支内
   `clearSelection()` 先于 `navigate`；navigate 目标 `/clarify/$nodeRunId`；`onSelectNodeRun(null)` 在分支内
   出现（drawer 永不为反问节点打开）。
9. **`useTaskSync` cross-clarify 刷新（设计门 Codex ③①，§4.6）**：`useWsInvalidation` 规则表单测/源码锁——
   `cross-clarify.created`/`answered`/`rejected` 三事件的规则各 invalidate `['tasks',taskId,'node-runs']`
   （+ clarifyKeys）；`answered`/`rejected` **保留**既有 `['task-clarify-directives',taskId]`（RFC-123 单源
   toggle，不得回归删除）；对拍 self `clarify.answered` 的 node-runs invalidation 仍在。
10. **集中作答面板本地失效（设计门 Codex ④②，§4.7）**：`CentralizedAnswerDialog` 提交成功 handler 源码锁/
   行为测试——invalidate 集合含 `['tasks',taskId,'node-runs']`（与既有 clarify/task-questions 失效并列，
   本地即时刷新兜底 WS）。

**既有锁迁移盘点**（feedback_grep_locks_before_push，实现前再全量 rg 复核一遍）：

- `NodeRunSchema` / node-runs 响应形状的**全字段锁**（如 rfc103 全字段锁、`review-schemas` 等）随
  `clarifyNavKind` 增列更新（同 RFC-158 增 `reviewNavKind` 的先例）。
- `shouldShowClarifyJump` / 表格「去回答」按钮的既有测试**零改动**（本 RFC 不碰表格入口）——必须保绿。
- `ClarifyNode` / `CrossClarifyNode` 既有渲染测试（`canvas-*` / `awaiting-node-highlight` 等）都不传
  `clarifyNav` → 走 undefined 分支，预期零适配（若因 DOM 追加断言失败，修断言语义而非绕开）。
- `getTaskNodeRuns` 既有测试（review-nav-kind / round-start / node-runs 响应）在增列后保绿；新增 clarify
  stamp 测试独立成文件。
- e2e：`clarify.spec.ts` / `review.spec.ts` API 驱动、`visual-regression` 8 页不含任务详情画布 → 双零影响。

## 7. 耦合点清单

| 触点 | 改动 |
|---|---|
| `shared/src/schemas/clarify.ts` | `ClarifyNodeNavKind` + `clarifyNavKindForRoundStatus`（居 `ClarifyRoundStatus` 旁） |
| `shared/src/schemas/task.ts` | `NodeRunSchema.clarifyNavKind?: 'awaiting'\|'answered'\|null`（紧邻 `reviewNavKind`，读时派生，无 migration） |
| `backend services/task.ts` | `getTaskNodeRuns` 加一次 clarify_rounds 载入（按 task）+ 每行 stamp `clarifyNavKind`（取 createdAt-max 轮状态 → 映射，与 getClarifyRoundDetail 同选法；canceled/failed 任务用已载 `task.status` 抑制孤儿 awaiting，一处算全） |
| `backend routes/clarify.ts` | defer 分支 `sealResult.roundFullySealed` 时补 emit intermediary run 的 `node.status(done)`（§4.7，best-effort） |
| `frontend lib/clarify-node-nav.ts`（新） | `deriveClarifyNodeNav`（**纯 freshest-run** over `clarifyNavKind`，镜像 `deriveReviewNodeNav`，不按 parent 过滤） |
| `frontend hooks/useTaskSync.ts` | 补 `cross-clarify.created`/`answered`/`rejected` 三规则 invalidate node-runs(+clarifyKeys)，`answered`/`rejected` 保留既有 directives（§4.6，cross↔self 同等待遇） |
| `frontend components/clarify/CentralizedAnswerDialog.tsx` | 提交成功 handler 追加 `['tasks',taskId,'node-runs']` invalidation（§4.7 本地兜底） |
| `frontend routes/tasks.detail.tsx` | TaskStatusCanvas：clarify 三件套 memo + onSelect clarify 分支（复用 RFC-158 的 navigate/canvasRef） |
| `frontend components/canvas/WorkflowCanvas.tsx` | `clarifyNavs` prop + ref-guard + `toFlowNodes` 注入（两 kind） |
| `frontend components/canvas/nodes/types.ts` | `CanvasNodeData.clarifyNav` |
| `frontend components/canvas/nodes/ClarifyNode.tsx` + `CrossClarifyNode.tsx` | data 属性 + 提示行（复用同组 i18n key） |
| `frontend styles.css` | `.canvas-node--clarify[data-clarify-nav], .canvas-node--clarify-cross-agent[data-clarify-nav]` cursor + `.canvas-node__clarify-nav` |
| `frontend i18n/zh-CN.ts` / `en-US.ts` | `clarifyNode.navAwaiting` / `navAnswered` |
| 调度 / 决策流 / clarify 写服务（createClarifySession/`sealRoundQuestions`/`autoDispatchClarifyRound`/park 事务与派发/选轮）/ `getClarifyRoundDetail` 排序 / ACL / migration | **零改动**（Finding 2 仅在 `routes/clarify.ts` defer 分支**追加**一个既有 `node.status` emit，不改封存事务/派发；clarify 选轮一致性划为非目标另立 RFC，见 §4.5/§3） |
