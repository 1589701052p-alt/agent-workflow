# RFC-015 Design — Fanout sourcePort 拖拽指定

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 修订基线：RFC-003（catch-all）/ RFC-006（PortHandles 行内化）/ RFC-007（review/output 拖拽 + `connectionSync` 模块已合并）

## 1. 总览

本 RFC 在 `agent-multi` 节点顶部新增一个**独立的 target Handle**（id `__multi_source_port__`），让用户可以通过拖拽完成 `node.sourcePort` 字段的写入，与左侧 RFC-003 catch-all 入边逻辑**完全并行、互不替代**。

新拖入语义：`sourcePort` 字段直接写入（不进 `definition.edges[]`），二次拖入静默替换旧值。

```
        ┌─────── designer ───────┐         ┌───────── audit (agent-multi) ──────────┐
        │  outputs:               │         │  ┌────────────┐                       │
        │   ▶ markdown_design ●───┼─────────┼──● __multi_source_port__  (顶部)      │
        │                         │         │  └────────────┘                       │
        └─────────────────────────┘         │                                       │
                                            │  catch-all (RFC-003) ●  普通入边      │
                                            │  ports.right ●  outputs.markdown_audit│
                                            └───────────────────────────────────────┘

           writes node.sourcePort = {nodeId: 'designer', portName: 'markdown_design'}
           does NOT add to definition.edges[]
```

backend / scheduler / validator / DB **零改动**：`sourcePort` 字段早就是 fanout 节点的独立顶级字段，scheduler 在 `:737` 与 dep graph 在 `:1320` 一直按字段读，本 RFC 只补编辑器层的拖拽入口。

---

## 2. 模块布局与影响面

```
packages/frontend/src/components/canvas/
├── fanoutSourceSync.ts            ← 新建（本 RFC）
├── connectionSync.ts              ← 不动（RFC-007 既有）
├── WorkflowCanvas.tsx             ← 改 handleConnect + handleNodesChange
├── nodes/
│   ├── AgentNode.tsx              ← fanout 形态多渲染一个顶部 <Handle>
│   ├── PortHandles.tsx            ← 不动
│   └── types.ts                   ← 新加一个 export 常量
└── NodeInspector.tsx              ← 抽屉表单追加 muted hint（i18n）

packages/frontend/src/
├── styles.css                     ← 新加 .canvas-node__handle--shard-source 视觉
└── i18n/{zh-CN,en-US}.ts          ← +2 条 inspector.sourcePortDragHint
```

**零碰**的层：

- `packages/shared/`（schema 与跨端类型不变）
- `packages/backend/`（scheduler / validator / runner / DB / migrations 一行不动）
- 其它已有节点（review / output / agent-single / wrapper-loop）渲染与逻辑

---

## 3. 数据模型与字段不变量

### 3.1 `sourcePort` 仍是独立字段

`WorkflowDefinition` 中 `node.sourcePort: { nodeId: string; portName: string }`（agent-multi 节点专有）：

- 仅在 `node.kind === 'agent-multi'` 时存在。
- 形态：`{ nodeId, portName }` 双字符串（schema 与 validator 已锁，本 RFC 不改）。
- 空值约定：`{ nodeId: '', portName: '' }` 表示未设。validator `agent-multi-source-port-missing` 在两者为空 / 缺字段时报红。

### 3.2 sourcePort 与 edges[] 的不变量

**核心不变量**：拖到顶部 handle **不**写 `edges[]`、拖到左侧 catch-all / 具名 handle **不**写 `sourcePort`。两条路径互斥。

| 拖拽落点                        | 写 `edges[]`               | 写 `sourcePort` | 备注                           |
| ------------------------------- | -------------------------- | --------------- | ------------------------------ |
| 顶部 `__multi_source_port__`    | **不写**                   | **写**          | 本 RFC 新增                    |
| 左侧 catch-all `__inbound__`    | 写（按 RFC-003 translate） | **不写**        | 普通入边；可被 `{{port}}` 引用 |
| 左侧具名输入 handle（如 `ctx`） | 写                         | **不写**        | 同上                           |

### 3.3 视觉契约：sourcePort 不画 xyflow edge

scheduler `:1320` 把 `sourcePort.nodeId → multi-node` 注入 DAG，**但**这条依赖在画布上不画线（不进 `definition.edges[]` 渲染流）。视觉用 handle 着色表达：

- `__multi_source_port__` 在 `sourcePort.nodeId !== ''` 时挂 className `canvas-node__handle--shard-source is-connected`：填充态 + 边框色用 `--accent` 色。
- 空时为空心淡色（`--muted`），提示"可拖入"。

理由：edges[] 一旦混入"伪 sourcePort 边"，validator / serialization / YAML 导入导出全面分支，超出本 RFC 范围；视觉差异化是低成本可逆方案。后续若做"sourcePort edge 化"是另一个 RFC 的事。

---

## 4. 新模块：`fanoutSourceSync.ts`

新建文件 `packages/frontend/src/components/canvas/fanoutSourceSync.ts`，所有函数纯参数 / 纯返回 / ref-equality 短路。

```ts
// ============================================================================
// RFC-015: fanout sourcePort drag-to-set helpers
//
// Pure transforms on WorkflowDefinition driven by three editor entry points:
//
//   1. WorkflowCanvas.handleConnect (top handle drop) → applySourcePortConnection
//   2. WorkflowCanvas.handleNodesChange (node removal) → clearSourcePortOnNodeRemoved
//   3. WorkflowCanvas.isValidConnection (drop validity)→ isValidSourcePortConnection
//
// Two-way sync with NodeInspector form is NOT needed here — the form binds
// directly to node.sourcePort and re-renders on definition updates.
// ============================================================================

import type { Connection } from '@xyflow/react'
import type { WorkflowDefinition, WorkflowNode } from '@aw/shared'

export const MULTI_SOURCE_PORT_HANDLE_ID = '__multi_source_port__'

/**
 * If `conn.targetHandle === MULTI_SOURCE_PORT_HANDLE_ID`, write the source
 * (src.nodeId + src.sourceHandle) into the matching agent-multi node's
 * `sourcePort` field and return a new definition. Otherwise return the
 * passed-in definition by reference (caller will fall through to the
 * RFC-003/RFC-007 edge-creation path).
 *
 * Replacement semantics: if the target node already has a sourcePort, it
 * is silently overwritten — the user dragging a fresh line is the explicit
 * "I want to change the source" signal.
 */
export function applySourcePortConnection(
  def: WorkflowDefinition,
  conn: Connection,
): WorkflowDefinition

/**
 * Called from handleNodesChange after a node-removal change is applied:
 * find every agent-multi node whose sourcePort.nodeId is in `removed`,
 * and reset its sourcePort to `{ nodeId: '', portName: '' }`. Returns
 * `def` by reference if no fanout node was affected.
 */
export function clearSourcePortOnNodeRemoved(
  def: WorkflowDefinition,
  removed: ReadonlyArray<string>,
): WorkflowDefinition

/**
 * Pure validity check used by `isValidConnection` BEFORE xyflow commits a
 * connection. Rejects:
 *   - non-top-handle drops (returns true — pass-through, not our concern)
 *   - target node not found or not agent-multi
 *   - source === target (self-loop on fanout)
 *   - source node not found
 * Otherwise returns true; the drop is allowed.
 *
 * No "source port must be markdown" check — scheduler doesn't require it,
 * and adding one here would create a UX/validator divergence trap.
 */
export function isValidSourcePortConnection(
  def: WorkflowDefinition,
  conn: { source: string | null; target: string | null; targetHandle: string | null },
): boolean
```

### 4.1 `applySourcePortConnection` 关键逻辑

```ts
if (conn.targetHandle !== MULTI_SOURCE_PORT_HANDLE_ID) return def
if (conn.source === null || conn.target === null) return def
if (conn.sourceHandle === null) return def
const idx = def.nodes.findIndex((n) => n.id === conn.target)
if (idx === -1) return def
const node = def.nodes[idx]
if (node.kind !== 'agent-multi') return def
const cur = (node as Record<string, unknown>).sourcePort as
  | { nodeId?: string; portName?: string }
  | undefined
if (cur?.nodeId === conn.source && cur?.portName === conn.sourceHandle) return def
const nextNode = { ...node, sourcePort: { nodeId: conn.source, portName: conn.sourceHandle } }
const nextNodes = [...def.nodes]
nextNodes[idx] = nextNode
return { ...def, nodes: nextNodes }
```

ref-equality 三处短路：（a）非顶部 handle 直接返回原 def；（b）目标节点非 fanout 直接返回原 def；（c）字段值未变直接返回原 def。

### 4.2 `clearSourcePortOnNodeRemoved` 关键逻辑

```ts
if (removed.length === 0) return def
const removedSet = new Set(removed)
let changed = false
const nextNodes = def.nodes.map((n) => {
  if (n.kind !== 'agent-multi') return n
  const sp = (n as Record<string, unknown>).sourcePort as
    | { nodeId?: string; portName?: string }
    | undefined
  if (sp?.nodeId === undefined || !removedSet.has(sp.nodeId)) return n
  changed = true
  return { ...n, sourcePort: { nodeId: '', portName: '' } }
})
return changed ? { ...def, nodes: nextNodes } : def
```

### 4.3 `isValidSourcePortConnection` 关键逻辑

```ts
if (conn.targetHandle !== MULTI_SOURCE_PORT_HANDLE_ID) return true
if (conn.source === null || conn.target === null) return false
if (conn.source === conn.target) return false // self-loop
const target = def.nodes.find((n) => n.id === conn.target)
if (target === undefined || target.kind !== 'agent-multi') return false
const source = def.nodes.find((n) => n.id === conn.source)
if (source === undefined) return false
return true
```

不查 source port 是否存在 / kind 是否合规——validator 在保存与启动任务时报错，编辑器只拦明显的"必然非法"案例。

---

## 5. AgentNode 渲染：顶部 handle

### 5.1 渲染分支

`AgentNode.tsx` 在 fanout 分支（`data.kind === 'agent-multi'`）渲染 PortHandles 之前 inline：

```tsx
import { Handle, Position, useUpdateNodeInternals } from '@xyflow/react'
import { MULTI_SOURCE_PORT_HANDLE_ID } from '../fanoutSourceSync'

// inside AgentNode component, fanout branch only:
const updateNodeInternals = useUpdateNodeInternals()
useEffect(() => {
  if (multi) updateNodeInternals(id)
}, [multi, id, updateNodeInternals])

return (
  <div ...>
    {multi && (
      <Handle
        type="target"
        position={Position.Top}
        id={MULTI_SOURCE_PORT_HANDLE_ID}
        className={
          'canvas-node__handle canvas-node__handle--shard-source' +
          (sourcePortConnected ? ' is-connected' : '')
        }
        aria-label="multi-source-port"
      />
    )}
    <div className="canvas-node__header">...</div>
    ...
  </div>
)
```

其中 `sourcePortConnected = (data as { sourcePort?: { nodeId?: string } }).sourcePort?.nodeId !== ''` —— 需要从 `CanvasNodeData` 把 `sourcePort` 透传上来（已在 `types.ts` 中存在则复用，否则在本 RFC 加一个 optional 字段，由 WorkflowCanvas 计算 `data` 时填）。

### 5.2 `CanvasNodeData` 扩展

在 `nodes/types.ts` 中：

```ts
export interface CanvasNodeData {
  // ...existing fields...
  /** Only meaningful for agent-multi; mirrored for handle styling. */
  sourcePort?: { nodeId: string; portName: string }
}
```

WorkflowCanvas 在把 `WorkflowNode` 翻译成 xyflow node 的位置（`toReactFlowNodes` 或等价函数）增加一行：`data.sourcePort = node.sourcePort`。

### 5.3 视觉规范

- Handle 几何位置：`Position.Top`，xyflow 默认渲染为节点顶部中心 8×8 圆点。
- className 标记：未连接 `canvas-node__handle--shard-source`（边框 dashed + `--muted` 色）；连接后追加 `is-connected`（填充 `--accent`）。
- 不在节点 body 内重复显示"sourcePort: x.y"——既有 fanout glyph + inspector 表单已覆盖，避免视觉膨胀。
- 不画 xyflow edge 连接到 designer（理由见 §3.3）。

### 5.4 xyflow `useUpdateNodeInternals` 时机

仅在 `multi`（agent-single ↔ agent-multi）切换时 call；ports list / sourcePort 字段变化 xyflow 自身 ResizeObserver 处理。

---

## 6. WorkflowCanvas 接入

### 6.1 `handleConnect` 改造

```ts
const handleConnect = useCallback(
  (conn: Connection) => {
    if (readOnly === true || onChange === undefined) return

    // RFC-015 fast path: top handle → write sourcePort, no edge.
    if (conn.targetHandle === MULTI_SOURCE_PORT_HANDLE_ID) {
      const next = applySourcePortConnection(definition, conn)
      if (next !== definition) commitChange(next)
      return
    }

    // RFC-007 (existing) path: catch-all or named handle → edge + field sync.
    const viaCatchAll = conn.targetHandle === INBOUND_HANDLE_ID
    const built = buildEdgeFromConnection(definition, translateInboundConnection(conn))
    if (built === null) return
    const withEdge = { ...definition, edges: [...definition.edges, built] }
    const synced = applyConnectionForReviewOutput(withEdge, built, { viaCatchAll })
    commitChange(synced)
  },
  [commitChange, definition, onChange, readOnly],
)
```

### 6.2 `isValidConnection` 改造

在既有 RFC-007 iterate 锁后追加 RFC-015 sourcePort 守护：

```ts
const isValidConnection = useCallback(
  (conn: { source: string | null; target: string | null; targetHandle: string | null }) => {
    // RFC-015: fanout sourcePort top-handle guards (self-loop, missing nodes).
    if (!isValidSourcePortConnection(definition, conn)) return false

    // RFC-007: iterate lock on review nodes.
    if (taskContext !== undefined && conn.target !== null) {
      const node = definition.nodes.find((n) => n.id === conn.target)
      if (node !== undefined && node.kind === 'review') {
        const iter = taskContext.reviewIteration[conn.target] ?? 0
        if (iter !== 0) return false
      }
    }
    return true
  },
  [definition, taskContext],
)
```

`isValidSourcePortConnection` 对非顶部 handle 永远返回 true，所以 RFC-007 路径不受影响。

### 6.3 `handleNodesChange` 改造

节点删除事件已经触发 `affectsDefinition` → commitChange 路径。本 RFC 在 commitChange 前调一次 `clearSourcePortOnNodeRemoved`：

```ts
const handleNodesChange = useCallback(
  (changes) => {
    setNodes((cur) => {
      const next = applyNodeChanges(changes, cur)
      if (onChange !== undefined && affectsDefinition(changes)) {
        const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
        let nextDef = toDefinition(definition, next, edges)
        if (removed.length > 0) {
          nextDef = clearSourcePortOnNodeRemoved(nextDef, removed)
        }
        commitChange(nextDef)
      }
      return next
    })
  },
  [commitChange, definition, edges, onChange, readOnly],
)
```

ref-equality 短路：无 fanout 节点被影响时 `clearSourcePortOnNodeRemoved` 返回原 def，`toDefinition` 的结果直接 commit 一次。

### 6.4 不动 EdgeInspector / 不动右侧抽屉表单

- EdgeInspector 不感知 sourcePort——顶部 handle 拖入不产生边，自然不进 EdgeInspector 视野。
- NodeInspector 的 `SourcePortField` 两下拉框是真值来源的纯展示，字段被拖拽改写后 React 重渲染自然刷新选项，不需要本 RFC 编写双向同步代码。

---

## 7. inspector 文案与 i18n

`NodeInspector` agent-multi 分支的 `<Field label="sourcePort">` 之前已经渲染。本 RFC 在 Field 下方加一条 muted 提示：

```tsx
<Field label={t('inspector.fieldSourcePort')} required>
  <SourcePortField ... />
  <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
    {t('inspector.sourcePortDragHint')}
  </p>
</Field>
```

i18n 新增 2 条 key：

- `zh-CN.ts`: `inspector.sourcePortDragHint: '也可以从节点顶部的端口直接拖入上游输出来设置。'`
- `en-US.ts`: `inspector.sourcePortDragHint: 'You can also drag an upstream output onto the handle at the top of this node to set the source.'`

---

## 8. 测试策略

按 [feedback_post_commit_ci_check] 三档：纯函数单测 + JSDOM 集成 + 源代码层兜底。

### 8.1 `fanout-source-sync.test.ts`（纯函数）

文件：`packages/frontend/tests/fanout-source-sync.test.ts`。13 case：

**`applySourcePortConnection`（6 case）**

1. 顶部 handle drop on fanout → 写字段 + 新 def 不等于原 def。
2. 顶部 handle drop on agent-single → 返回原 def（ref-equality）。
3. 顶部 handle drop on review → 返回原 def。
4. 非顶部 handle（targetHandle === `__inbound__` / 具名 / null）→ 返回原 def。
5. 二次 drop 不同 source → sourcePort 切换。
6. 二次 drop 同 source 同 port → 返回原 def（ref-equality）。

**`clearSourcePortOnNodeRemoved`（3 case）**

1. 删除被 fanout 引用的源节点 → fanout.sourcePort 重置为空。
2. 删除无关节点 → 返回原 def。
3. 一次删多个含 fanout 源 → 全部清扫；不在 removed 集合里的 fanout 不动。

**`isValidSourcePortConnection`（4 case）**

1. 非顶部 handle 永远返回 true。
2. 顶部 handle 自环 → false。
3. 顶部 handle target 非 fanout → false。
4. 顶部 handle source 节点不存在 → false。
5. 顶部 handle 合法 → true。

### 8.2 `canvas-fanout-source-port-drag.test.tsx`（JSDOM 集成）

文件：`packages/frontend/tests/canvas-fanout-source-port-drag.test.tsx`。5 case：

1. 渲染 fanout 节点 → 断言 DOM 含 `Handle[id="__multi_source_port__"]`。
2. `onConnect({source:'designer', sourceHandle:'markdown_design', target:'audit', targetHandle:'__multi_source_port__'})` → 回调 def 中 `audit.sourcePort` 写入 + `edges[]` 不变。
3. 二次 `onConnect` 不同 source → sourcePort 替换。
4. `onConnect({...targetHandle:'__inbound__'})` → `edges[]` +1 且 sourcePort 不动。
5. `onNodesChange([{type:'remove', id:'designer'}])` → audit.sourcePort 被清空。

### 8.3 既有套件零回归

执行 `bun run --filter @aw/backend test`：

- `tests/scheduler-*.test.ts`
- `tests/workflow-validator.test.ts`

整套必须全绿。本 RFC 不动 backend 任何代码，但跑一遍证伪"我以为没动其实动了"。

frontend 既有 RFC-003 / RFC-004 / RFC-006 / RFC-007 测试套件同样必须全绿。

### 8.4 `canvas-fanout-source-port-not-floating.test.ts`（源代码层兜底）

文件：`packages/frontend/tests/canvas-fanout-source-port-not-floating.test.ts`。
模式参照 RFC-006 `canvas-port-label-not-floating.test.ts` + RFC-007 `canvas-review-output-drag-not-floating.test.ts`：fs.read + 正则。

锁定：

- `AgentNode.tsx` 含 `__multi_source_port__` 字面量、`position={Position.Top}` / `Position.Top`、`type="target"`、`canvas-node__handle--shard-source`。
- `fanoutSourceSync.ts` 文件存在、export `MULTI_SOURCE_PORT_HANDLE_ID` + `applySourcePortConnection` + `clearSourcePortOnNodeRemoved` + `isValidSourcePortConnection`。
- `WorkflowCanvas.tsx` 含 `from './fanoutSourceSync'` 与 `applySourcePortConnection(` 调用、`clearSourcePortOnNodeRemoved(` 调用、`isValidSourcePortConnection(` 调用。
- `styles.css` 含 `.canvas-node__handle--shard-source` + `.canvas-node__handle--shard-source.is-connected`。
- `i18n/zh-CN.ts` 与 `i18n/en-US.ts` 含 `sourcePortDragHint`。

文件顶部注释：链回本 RFC + commit hash placeholder `<TBD-commit-hash>`，说明 JSDOM 无 layout / xyflow drag-drop 测试代价高，源码层兜底必要。

### 8.5 e2e

本 RFC **不**扩 `e2e/main.spec.ts`：xyflow 在 Playwright 上模拟拖拽代价不成比例，且本 RFC 所有视觉与行为都被 JSDOM 集成 + 源代码层兜底锁定。CI 既有 e2e 矩阵照常跑保 RFC-006 / RFC-007 不退化即可。

---

## 9. 安全 / 并发 / 性能

- **无新输入面**：本 RFC 完全在编辑器内，无新 REST / WS / 文件 IO，零新攻击面。
- **并发**：与 RFC-003 既有多 tab 同步 `/ws/workflows` 路径完全兼容——本 RFC 写的是 `definition.nodes[i].sourcePort` 字段，与既有字段写入走同一 commitChange + auto-save 路径。
- **性能**：拖拽 / 删除事件本就是 O(节点数)；新增的 `clearSourcePortOnNodeRemoved` 是 O(节点数) 单次遍历；`applySourcePortConnection` 是 O(节点数) findIndex。
- **bundle size**：新增 `fanoutSourceSync.ts` ≈ 60 行 TS + 2 条 i18n + ~5 行 CSS。可忽略。

---

## 10. 与其他 RFC 协调

| RFC                                            | 交集                           | 处理                                                                                                                 |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| RFC-003（catch-all）                           | fanout 节点左侧 catch-all 行为 | **不动**；本 RFC 顶部 handle 与 catch-all 是双轨独立                                                                 |
| RFC-004（input port contract）                 | 无                             | 不动                                                                                                                 |
| RFC-006（PortHandles 行内化）                  | AgentNode 渲染结构             | **不动 PortHandles**；本 RFC 顶部 handle 是 inline `<Handle>`，不混进 PortHandles 分支                               |
| RFC-007（review/output 拖拽 + connectionSync） | `handleConnect` 入口           | **新增**先于 RFC-007 路径的 fast-path 判断（`targetHandle === MULTI_SOURCE_PORT_HANDLE_ID`）；RFC-007 路径完全不感知 |
| RFC-005（review 节点）                         | 无                             | 不动                                                                                                                 |
| RFC-014（iterate sibling regen）               | 无                             | sourcePort 与 review 节点的 inputSource 字段独立，本 RFC 不影响 RFC-014                                              |

---

## 11. 失败模式与回滚

- **fast-path 误判**：`handleConnect` 入口若把 `__multi_source_port__` 与 RFC-003 `__inbound__` 混淆 → 边没写、字段没写、用户拖了个寂寞。**兜底**：JSDOM 集成测 case 2 + case 4 同时验证。
- **`useUpdateNodeInternals` 漏调**：用户在 fanout / single 间切 kind 时 handle 不出现。**兜底**：useEffect 监听 `multi` 标记；JSDOM 测渲染时直接渲染 fanout 形态，case 1 锁渲染。
- **删除级联漏触发**：`changes.filter(remove)` 没拿到被删 ids → fanout.sourcePort 留作 stale。**兜底**：纯函数测 case + JSDOM 集成 case 5 覆盖删除路径。
- **回滚**：`git revert` 单 PR。fanout 节点回到"只能在抽屉里两下拉选"；老 workflow / DB / scheduler 完全不受影响。

---

## 12. 完成定义

- [ ] §4 新模块 `fanoutSourceSync.ts` 落地，4 个 export（1 常量 + 3 函数）
- [ ] §5 AgentNode fanout 分支顶部 handle 渲染 + `useUpdateNodeInternals` 时机正确
- [ ] §6 WorkflowCanvas `handleConnect` / `isValidConnection` / `handleNodesChange` 三处接入
- [ ] §7 inspector i18n hint + CSS `.canvas-node__handle--shard-source` 落地
- [ ] §8.1 13 case 纯函数测全绿
- [ ] §8.2 5 case JSDOM 集成测全绿
- [ ] §8.3 backend + frontend 既有套件零回归
- [ ] §8.4 源代码层兜底测全绿
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] 推 push 后 GitHub Actions 矩阵全绿（按 [feedback_post_commit_ci_check]）
- [ ] proposal §4 验收标准 10 条全部映射到测试 ID
- [ ] STATE.md / design/plan.md 索引同步落 Done
