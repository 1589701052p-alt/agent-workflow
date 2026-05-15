# RFC-007 Design — Canvas review / output 节点拖拽连线技术设计

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 影响范围：`packages/frontend/src/components/canvas/**`（renderer + connect/disconnect + connectionSync helper）+ `packages/frontend/src/routes/workflows.edit.tsx`（heal 扩展）+ vitest 测试。后端 / shared schema / DB / runtime 零改动。

## 1. 当前实现剖析

### 1.1 三套数据并存

`packages/shared/src/schemas/workflow.ts` 定义的工作流文档里，"上下游数据流"有三个来源：

| 字段                                         | 谁写                                                | 谁读                                                       | 当前一致性                                                |
| -------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| `definition.edges[]`（`source`/`target` 对） | canvas connect / EdgeInspector / YAML 导入          | canvas 渲染 / 静态校验 / scheduler 反向推导 input port      | 与字段独立                                                |
| `node.inputSource: PortRef`（review 专用）   | NodeInspector review 分支表单 / YAML 导入            | scheduler `dispatchReviewNode` 读它取上游 doc_version 数据 | 与边互不感知                                              |
| `node.ports[i].bind: PortRef`（output 专用） | NodeInspector output 分支表单 / YAML 导入            | scheduler 收尾时按 bind 抓上游 port 内容回写 task outputs  | 与边互不感知                                              |

`definition.edges[]` 是 scheduler 推导 DAG 拓扑、判定节点就绪条件的真值；`inputSource` / `port.bind` 才是"具体取哪个 port 的值"的真值。一个节点可以有边但字段空（output 拖出来视觉上有边但 bind 空）、字段有但无边（手填 inputSource 后画布上没线），运行时按字段，编辑期看边——视觉与语义两套答案。

### 1.2 现有 connect 单路

`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:239-247`：

```ts
const handleConnect = useCallback(
  (conn: Connection) => {
    if (readOnly === true || onChange === undefined) return
    const built = buildEdgeFromConnection(definition, translateInboundConnection(conn))
    if (built === null) return
    commitChange({ ...definition, edges: [...definition.edges, built] })
  },
  [commitChange, definition, onChange, readOnly],
)
```

唯一动作：追加边。无论 target 是 agent / review / output / wrapper-loop，都只走这一条路径。

`translateInboundConnection(conn)`（RFC-003 引入）：若 `targetHandle === INBOUND_HANDLE_ID`（即 `__inbound__` catch-all），把它改写为 `sourceHandle`，让边的目标 portName 与上游 portName 同名。对 review / output 节点，catch-all 不启用，此处不会触发改写。

### 1.3 现有 disconnect 路径

边删除有三条路径：

1. 边被选中 → 按 Delete / Backspace（xyflow 默认 + WorkflowCanvas `deleteKeyCodes`）
2. EdgeInspector 删除按钮（RFC-003）
3. 节点删除时，xyflow 自动联级删除该节点关联的所有边（onNodesChange 路径）

三条路径最终都更新 `definition.edges[]`。**没有一条会回写 `inputSource` / `port.bind`**。

### 1.4 渲染层差异

- **AgentNode**：`PortHandles side="left" ports={inputPorts} catchAll={INBOUND_HANDLE_ID}` + `PortHandles side="right" ports={outputPorts}`。左侧具名 handle + catch-all 透明带，新边可落具名也可落 catch-all。
- **ReviewNode** (`packages/frontend/src/components/canvas/nodes/ReviewNode.tsx:37`)：仅 `PortHandles side="right" ports={outputPorts}`。**左侧无任何 target handle**。
- **OutputNode** (`packages/frontend/src/components/canvas/nodes/OutputNode.tsx:21`)：`PortHandles side="left" ports={inputPorts}`。具名 handle 已存在，type="target"，xyflow 允许边落上，但落上去 handleConnect 不写 bind。
- **InputNode** (无对称问题)：仅 right-side source handles，不需要 bind 字段，本 RFC 不涉及。

## 2. 设计原则

1. **字段为真值，边为视觉同源**。scheduler 仍读 `inputSource` / `port.bind`，本 RFC 不挪动这个合约。本 RFC 让前端编辑期保证"字段 ↔ 边" 严格一致。
2. **三入口归一**：connect、disconnect、表单提交三条用户操作入口，全部走 `connectionSync` 同一 helper 模块。保证不论从哪进，两套数据同步原子完成。
3. **加 handle，不加 prop**：review 节点新增 `__review_input__` handle 走 ReviewNode.tsx 直接 inline 一个 `<Handle>`（不沿用 PortHandles，避免给 PortHandles 加新分支）。output 节点 0 改动，因为左侧 handles 已经在了。
4. **不改 schema 字段必填性**：`inputSource: PortRefSchema`（review）保持非可选，仅靠 connect/disconnect 保证有边时字段写值、无边时字段清空（空 PortRef = `{nodeId: '', portName: ''}`，与现有验证逻辑一致）。schema PortRefSchema 允许空字符串字段（既有行为）。
5. **iterate 锁只在 task 详情画布生效**：编辑器画布是工作流"模板"视图，运行时已经 snapshot 了定义；编辑器画布拖拽换源不会影响已启动的任务。Task 详情画布是 read-only（`tasks.detail.tsx:309 TaskStatusCanvas`），本来就不让连边——本 RFC 仅强化"即使 read-only 关掉了又被绕过，也拒绝"。

## 3. 渲染层改动

### 3.1 ReviewNode：新增左侧 target Handle

**文件**：`packages/frontend/src/components/canvas/nodes/ReviewNode.tsx`

**改动**：
- 删除注释 line 7-8 "Catch-all inbound strip is intentionally off..."，替换为说明本 RFC 引入的具名 input handle 的注释。
- 在 `<div className="canvas-node canvas-node--review">` 内部、`<PortHandles side="right">` 之前，inline 一个 `<Handle>`：

```tsx
import { Handle, Position } from '@xyflow/react'

const REVIEW_INPUT_HANDLE_ID = '__review_input__'

// ... in component:
<Handle
  type="target"
  position={Position.Left}
  id={REVIEW_INPUT_HANDLE_ID}
  className="canvas-node__handle canvas-node__handle--review-input"
  aria-label="review-input"
/>
```

- 不用 PortHandles：PortHandles 当前是"按 ports 数组渲染若干行"的循环器；review 只有一个固定 handle，inline 更直白也避免给 PortHandles 加新 prop。
- handle 视觉位置：默认 xyflow 把 `Position.Left` 钉在节点垂直居中位置；review 节点高度由 header + id + (optional) inputSource 行 + outputs 行决定，垂直居中刚好落在节点中部，视觉上和 outputs handle 对称。CSS 复用 `.canvas-node__handle` 8px dot + accent 色（RFC-006 既有）。可以加一条 `.canvas-node__handle--review-input { /* 留空 */ }` 占位 className 以备未来微调。
- 导出 `REVIEW_INPUT_HANDLE_ID` 常量到 `connectionSync.ts`（或 types.ts），让 WorkflowCanvas connect 路径能识别。

### 3.2 OutputNode：零渲染层改动

`OutputNode.tsx:21` 已经渲染了具名 target handles。无需新增 DOM。

唯一关心：output 节点的 port name = `port.name`（NodeInspector 编辑），但 bind 是另一字段。Handle id 就是 port.name —— xyflow 用 id 匹配边端点；本 RFC 在 connect 时识别"目标是 output 节点 + targetHandle 落在某个具名 port"→ 写对应 port 的 bind。

### 3.3 PortHandles 不动

PortHandles 自身职责仍是"按 ports 数组渲渲一组 handle 行"，不识别节点种类。判定"是不是 review/output"的逻辑统一放 `connectionSync.ts`，按 `definition.nodes[].kind` 判断。

### 3.4 useUpdateNodeInternals

review 节点新增 handle 是组件源码层面的改动，不是数据层。xyflow `<Handle>` 在挂载时自动注册到节点内部表；不需要手动 `useUpdateNodeInternals`。仅当节点 data 在运行时改变 ports 列表（agent 节点改 outputs）时才需要那个 hook，本 RFC review 节点的 input handle 是常量。output 节点的 inputPorts 数组改变时已由 RFC-006 / RFC-003 配套 hook 处理。

## 4. connectionSync 纯函数模块

**文件**：`packages/frontend/src/components/canvas/connectionSync.ts`（新建）

**导出**：

```ts
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode, PortRef } from '...'

export const REVIEW_INPUT_HANDLE_ID = '__review_input__'

/**
 * Decide whether a built edge targets a review or output node, and if so
 * produce the next definition where both the edge AND the corresponding
 * field (inputSource / port.bind) reflect the new wiring. Pure function.
 *
 * Behavior:
 * - target is review + targetHandle === __review_input__:
 *     1. drop any existing edge whose target.nodeId === reviewNodeId
 *     2. append the new edge (with target.portName = REVIEW_INPUT_HANDLE_ID)
 *     3. write node.inputSource = { nodeId: src.nodeId, portName: src.portName }
 * - target is output + targetHandle matches one of node.ports[].name:
 *     1. drop any existing edge whose target.nodeId === outputNodeId &&
 *        target.portName === matched port
 *     2. append the new edge (target.portName = matched port name)
 *     3. write node.ports[i].bind = { nodeId: src.nodeId, portName: src.portName }
 * - otherwise: return definition unchanged + caller-supplied edge appended as-is
 *   (lets WorkflowCanvas keep the agent / loop / wrapper path verbatim).
 */
export function applyConnectionForReviewOutput(
  def: WorkflowDefinition,
  edge: WorkflowEdge,
): WorkflowDefinition

/**
 * Mirror of the above for edge deletion. For each deleted edge, if its target
 * is review/output, clear the corresponding inputSource / port.bind. Pure.
 */
export function applyDisconnectForReviewOutput(
  def: WorkflowDefinition,
  deletedEdges: WorkflowEdge[],
): WorkflowDefinition

/**
 * When the user types into NodeInspector's inputSource.nodeId / portName
 * (review) or port.bind.nodeId / portName (output), the canvas edges need
 * to follow. Given the previous + next PortRef plus the target node/port,
 * this helper rewrites definition.edges accordingly:
 * - if next is empty ({nodeId:'', portName:''}), drop the matching edge
 * - if next is non-empty, replace (or add) the matching edge
 * Pure function; ref-equality short-circuits when next === prev.
 */
export function syncEdgeFromFormField(
  def: WorkflowDefinition,
  target: { nodeId: string; portName: string }, // for review: portName = __review_input__
  prev: PortRef | null,
  next: PortRef | null,
): WorkflowDefinition

/**
 * Idempotent "heal" pass: scan all review / output nodes; for each one,
 * if inputSource / port.bind is non-empty but no matching edge exists in
 * definition.edges, append the edge. Also the reverse: if an edge exists
 * but the field is empty, write the field (handles YAML-import path).
 * Pure; ref-equality short-circuits when no change.
 */
export function healFieldEdgeConsistency(
  def: WorkflowDefinition,
): WorkflowDefinition
```

**纯函数纪律**：

- 输入输出都是 `WorkflowDefinition`；不持有任何外部状态。
- 不变化时**返回原引用** —— 让上游 React useEffect 走 ref-equality 短路，杜绝双向同步死循环（RFC-004 healLoadedDefinition 同款手法）。
- 任何"找不到的源节点"或"端口名不匹配"都按"不修改字段"处理（写不进去就不写，留给静态校验告警）；本 helper 不做校验。

## 5. WorkflowCanvas 三入口接入

### 5.1 handleConnect

```ts
const handleConnect = useCallback(
  (conn: Connection) => {
    if (readOnly === true || onChange === undefined) return
    const built = buildEdgeFromConnection(definition, translateInboundConnection(conn))
    if (built === null) return
    const withEdge = { ...definition, edges: [...definition.edges, built] }
    commitChange(applyConnectionForReviewOutput(withEdge, built))
  },
  [commitChange, definition, onChange, readOnly],
)
```

`applyConnectionForReviewOutput` 内部会按需删旧边（review 单输入 / output port 单输入）+ 写字段，返回 next definition。

### 5.2 isValidConnection（iterate 锁）

xyflow `<ReactFlow isValidConnection={fn}>` 在拖拽过程中实时调，返回 false 不让连接完成。仅在 read-only 画布（task 详情）下接入：

```ts
const isValidConnection = useCallback(
  (conn: Connection | Edge) => {
    if (taskContext === undefined) return true // editor canvas, no iterate lock
    if (conn.target === null) return true
    const node = nodes.find((n) => n.id === conn.target)
    if (node === undefined) return true
    if (node.data.kind !== 'review') return true
    const iter = taskContext.reviewIteration[conn.target] ?? 0
    return iter === 0
  },
  [nodes, taskContext],
)
```

Editor canvas 上 `taskContext` 始终 undefined → 永远 true，编辑期无 iterate 锁（design.md §2 第 5 条原则）。

### 5.3 edge 删除路径

xyflow 删除通过 `onEdgesChange` 回调来；现有 WorkflowCanvas 已经在该回调里 commitChange。在 commitChange 之前，把被删边数组传给 `applyDisconnectForReviewOutput`：

```ts
// pseudo
const deletedEdges = changes
  .filter((c) => c.type === 'remove')
  .map((c) => definition.edges.find((e) => e.id === c.id))
  .filter((e): e is WorkflowEdge => e !== undefined)
const remaining = definition.edges.filter((e) => !deletedEdges.includes(e))
const next0 = { ...definition, edges: remaining }
commitChange(applyDisconnectForReviewOutput(next0, deletedEdges))
```

节点删除联级删边由 xyflow 自动产生 edge 'remove' change 事件，本 helper 不需要单独 hook 节点删除路径。

### 5.4 NodeInspector 表单写回

NodeInspector 的 review 分支（`inputSource.nodeId` / `inputSource.portName` 输入框）与 output 分支（`port.bind.nodeId` / `port.bind.portName`）原本只调 onChange 改字段。改为：

- 表单事件先调 `syncEdgeFromFormField(def, target, prev, next)` 算出新 definition
- 把整个 next definition commitChange 回去

NodeInspector 已有 `onCommitDef: (next) => void`（RFC-004 引入）走整 definition 提交路径，复用即可。

## 6. workflows.edit.tsx：扩 heal

RFC-004 已有 `healLoadedDefinition(prev, nodes)`，目前职责是同步 `definition.inputs[]`。本 RFC 在它前后加一段：

```ts
const next0 = healInputDefs(prev) // RFC-004 既有
const next1 = healFieldEdgeConsistency(next0) // RFC-007 新增
return next1
```

`healFieldEdgeConsistency` 双向同步：

- 字段有 + 边无 → 追加边（不改字段）
- 字段无 + 边有 → 写字段（不改边；来源是 YAML 导入路径）
- 双方都有但不一致 → 以**边为准**写字段（视觉是用户最近的操作，假定字段是历史残留）

ref-equality 短路：完全一致时返回 `prev`，让 useEffect 不触发脏写回。

## 7. 旧注释 / schema 文案同步

- `ReviewNode.tsx` 顶部注释更新：删除"Catch-all inbound strip is intentionally off"，改写为"Single named target Handle `__review_input__` accepts the review's input edge; the connect handler writes both the edge and `inputSource` (see RFC-007)"。
- `review.ts:47-49` 注释更新：删除"Catch-all edges in canvas (RFC-003) feed the input"（这从来没实现过），改写为"A single named target Handle `__review_input__` on the canvas feeds the input; connect/disconnect/form-edit keep `inputSource` and the matching edge in sync (RFC-007)"。

## 8. 测试策略

### 8.1 纯函数单测

**`packages/frontend/tests/connection-sync.test.ts`**（新建）

- `applyConnectionForReviewOutput`：
  - case 1：target 是 agent → 返回原 definition（不改字段，只是 caller 已经 push 了边）。
  - case 2：target 是 review，previous 无入边 → 字段写入；边数 +0（边已由 caller push）。
  - case 3：target 是 review，previous 有一条入边 → 旧边被删；字段更新；边数净变化 0。
  - case 4：target 是 output 节点的 `final_doc` port，previous 该 port 无入边 → port.bind 写入；其他 port bind 不动。
  - case 5：target 是 output 但 targetHandle 与任何 port name 不匹配 → 返回原 definition（caller push 的边保留但无字段写）。
  - case 6：source 节点不存在 → 仍写字段（按 caller 传的 source 信息），不校验。
- `applyDisconnectForReviewOutput`：
  - case 1：删的是 review 入边 → inputSource 清空（`{nodeId: '', portName: ''}`）。
  - case 2：删的是 output port 入边 → 对应 port.bind 清空。
  - case 3：删的是普通 agent 入边 → definition 不变。
  - case 4：一次删多条（节点删除联级）→ 多个字段一并清空。
- `syncEdgeFromFormField`：
  - case 1：prev 空 + next 有 → 追加新边。
  - case 2：prev 有 + next 空 → 删旧边。
  - case 3：prev 有 + next 不同 → 替换边。
  - case 4：prev = next → ref-equality 返回原 definition。
- `healFieldEdgeConsistency`：
  - case 1：review 节点 inputSource 有 + 边无 → 追加边。
  - case 2：output port.bind 有 + 边无 → 追加边。
  - case 3：review 节点边有 + inputSource 空（YAML 导入路径）→ 写字段。
  - case 4：双方都有且一致 → ref-equality 短路。
  - case 5：双方都有但不一致 → 字段被改成边的值。

### 8.2 Canvas 集成测试

**`packages/frontend/tests/canvas-review-output-drag.test.tsx`**（新建）

JSDOM + React Testing Library + 完整 `<WorkflowCanvas definition={...} onChange={spy}>`，模拟 xyflow 调 `onConnect` 钩子（不真拖拽 DOM，xyflow 的 drag-drop 在 JSDOM 无法跑；直接调 prop `onConnect({source, target, sourceHandle, targetHandle})`）：

- case 1：connect 到 `__review_input__` → spy 收到 next definition：含新边 + inputSource 已写。
- case 2：第二次 connect 不同源 → 边总数不变；inputSource 指向新源。
- case 3：connect 到 output 的 `final_doc` → spy 收到 next：edges +1 + 对应 port.bind 已写。
- case 4：从场景 1 状态调 `onEdgesChange` 模拟删边 → next 中 inputSource 清空。
- case 5：iterate 锁 —— 带 `taskContext={reviewIteration: { reviewN: 1 }}` 的画布上 connect 到 review → `isValidConnection` 返回 false（直接断言 prop 调用）。

### 8.3 老 workflow heal 测试

**`packages/frontend/tests/canvas-edit-old-workflow.test.ts`**（既有，扩展）

- 既有 case 保留（RFC-004 inputs[] heal）。
- 新加 case：fixture workflow 含 review 节点 inputSource 有值、edges[] 空 → 跑 healLoadedDefinition → 输出 edges 多一条；ref-equality 测："已经一致" fixture 跑过返回原引用。
- 新加 case：fixture workflow 含 output 节点 port.bind 有值、edges[] 空 → heal 后 edges 多对应数量。
- 新加 case：YAML 导入路径 fixture —— edges 有但字段空 → heal 后字段被写。

### 8.4 源代码层兜底

**`packages/frontend/tests/canvas-review-output-drag-not-floating.test.ts`**（新建）

fs.read + 正则，按 [feedback_post_commit_ci_check] "源代码层兜底"模式锁住：

- `ReviewNode.tsx` 含字符串字面量 `__review_input__`；含 `<Handle` 且 `type="target"`；**不再含** `Catch-all inbound strip is intentionally off`。
- `connectionSync.ts` 文件存在并 export `applyConnectionForReviewOutput` / `applyDisconnectForReviewOutput` / `syncEdgeFromFormField` / `healFieldEdgeConsistency` 四个函数名。
- `WorkflowCanvas.tsx` `import` 来自 `./connectionSync`；`handleConnect` 体内调用 `applyConnectionForReviewOutput`。
- `workflows.edit.tsx` 调用 `healFieldEdgeConsistency`。

文件顶部注释链回本 RFC + commit hash（commit 落地后填）；说明 JSDOM 不跑 layout、节点种类判定行为需要源码层断言兜底。

### 8.5 e2e（可选，归到 follow-up）

Playwright e2e（`e2e/main.spec.ts`）已经覆盖 agent 拖拽连边。本 RFC 是否加 e2e：design 评估留 follow-up（plan.md §3 标 optional），因为单元 + 集成测已覆盖主要回归点；e2e 走真浏览器跑 xyflow drag-drop 工具复杂度高。如最终决定加，至少跑一条 "review 拖拽 → save → reload → 边仍在 + 字段仍在"。

### 8.6 三件套门槛

`bun run typecheck && bun run test && bun run format:check` 全绿才能 push；GitHub Actions matrix（macos/ubuntu × Lint+Typecheck+Test / Build single-binary / Playwright e2e）全绿后才算交付。

## 9. 与 RFC-005 iterate 语义的边界

RFC-005 design.md §9 的 iterate 规则：当 review 节点 `reviewIteration >= 1` 时，重跑只允许 target port 的字符串值变化（agent 重新生成同名 port），不允许换 inputSource 或换 sourceNode——否则 doc_versions 历史失去意义。

本 RFC 的处理：

- **运行时（已存在）**：scheduler 拿的是 task 启动那一刻的 workflow snapshot（design.md §3 任务运行模型已经如此）。后续在编辑器里改 workflow，**对已运行的任务 0 影响**。所以本 RFC 在编辑器上即使允许拖拽换源，也不会破坏任何已存在的 doc_versions。
- **task 详情画布（read-only + 本 RFC 新增锁）**：`tasks.detail.tsx` 渲染的 `TaskStatusCanvas` 是 read-only 的，xyflow `nodesDraggable={false} elementsSelectable={true} ...` 不让拖拽（既有行为）。本 RFC 在它之上加 `isValidConnection` 兜底：万一未来 read-only 标志被绕过 / 误开，对 review 节点 iterate 状态的 connect 立即拒绝。

简言之：编辑器画布不感知 iterate 态；task 详情画布只读 + 双重保险 isValidConnection。这条边界写进 NodeInspector 的提示（iterate 态下 inputSource 表单旁加一条灰字 "iterate 中，更换评审目标不会影响本次任务"）。

## 10. 性能与一致性

- `connectionSync` 函数全部纯 + ref-equality 短路；不会引入额外 re-render。
- `healFieldEdgeConsistency` 仅在 workflow load 时跑一次（RFC-004 既有 useEffect 注册），跑完字段一致后即 return 原引用；不持续触发。
- xyflow `<Handle>` 注册：review 新增一个常量 handle，组件挂载时一次性走完注册流程；handle 数量增加 N=1 对节点渲染开销可忽略。

## 11. 回滚剧本

- 本 RFC 单 PR 落地。出问题 `git revert <commit>` 即恢复"字段独立、边独立"现状。
- 已用新逻辑保存过的 workflow：仍然合法（边和字段一致，且 schema 没变）。回滚后这些 workflow 的运行时行为 0 变化（scheduler 一直读字段）；编辑期表现回退为"边和字段各管各的"（最坏情况：用户拖了边但 bind 没写——这正是 RFC-007 之前的常态）。
- 已用新逻辑保存的老 workflow（heal 补过边的）：边是合法补出来的，对老编辑器只是多出一条线，无害。
