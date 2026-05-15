# RFC-003 Design — Canvas 输入端口连边可达性

> 状态：Draft（2026-05-15）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 总览

四件事：

1. **PortHandles 增加 catch-all 模式** —— 加一个可选的 `catchAll: { id: string }` prop。当传入时，在左侧多渲染一个 `type='target'`、占满左侧 12px 宽不可见 hit zone 的隐藏 `<Handle>`，id 走调用方传入的固定字符串（约定 `__inbound__`）。具名 handle 仍然用同一组件渲染，z-index 高一层，确保命中优先。
2. **canvas 节点开关 catch-all** —— `AgentNode` / `LoopWrapperNode` 渲染 catch-all；`GitWrapperNode` / `InputNode` / `OutputNode` 不渲染。
3. **WorkflowCanvas 在 onConnect 把 catch-all 转译成 portName** —— 当 `targetHandle === '__inbound__'` 时，复用 `sourceHandle` 作 target.portName，再走 `buildEdgeFromConnection` 走原有去重 / 自环检测。
4. **EdgeInspector** —— 新增一个 inspector pane，与现 NodeInspector 互斥显示。点击 edge → 选中 → 抽屉切到 EdgeInspector，可改 `target.portName`，含冲突检测。

附带：

5. AgentNode NodeInspector 在 PortRefList 下方加一行"未连入的 `{{x}}` 引用"提示。
6. 编辑器路由的 `selection` 状态升级为 discriminated union（node / edge / null）。

## 2. 改动文件清单

前端：

- `packages/frontend/src/components/canvas/nodes/PortHandles.tsx` — 加 `catchAll?: { id: string }` prop；catch-all `<Handle>` 与具名 handles 共渲。
- `packages/frontend/src/components/canvas/nodes/AgentNode.tsx` — `<PortHandles side="left" ... catchAll={{ id: INBOUND_HANDLE_ID }}>`。
- `packages/frontend/src/components/canvas/nodes/WrapperNodes.tsx` — `LoopWrapperNode` 左侧加 catch-all；`GitWrapperNode` 不动。
- `packages/frontend/src/components/canvas/nodes/types.ts` — 导出常量 `INBOUND_HANDLE_ID = '__inbound__'`。
- `packages/frontend/src/components/canvas/WorkflowCanvas.tsx`：
  - `handleConnect`：拦截 `targetHandle === INBOUND_HANDLE_ID`，改写为 `sourceHandle`，再 `buildEdgeFromConnection`。
  - 新增 `onEdgeClick` handler，更新 selection；`onSelect` 接口由 `(nodeId|null)` 升级为 `(sel: Selection|null)`。
  - 调用 `<ReactFlow>` 时把 `onEdgeClick` 接进去。
- `packages/frontend/src/components/canvas/EdgeInspector.tsx`（新）— 选中 edge 时渲染：source readonly + target.portName editable + 保存 / 删除按钮。
- `packages/frontend/src/components/canvas/NodeInspector.tsx` — 在 agent 分支 PortRefList 下方加 `MissingRefList`：解析 `promptTemplate` 中的 `{{xxx}}`，diff 出当前 inputs 没覆盖的 token，列出。
- `packages/frontend/src/routes/workflows.detail.tsx`（或承载 inspector 的容器，按现状定位）— `selection` state 升级为 discriminated union；根据 `selection.kind` 渲 NodeInspector vs EdgeInspector。
- `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts` — 加：
  - `inspector.edgeTitle / edgeSourceLabel / edgeTargetLabel / edgePortNameLabel / edgeConflictMsg / edgeDeleteBtn`
  - `inspector.missingRefsLabel / missingRefsHint`
  - 共 ~8 条 key。

测试：

- `packages/frontend/tests/canvas-port-handles.test.tsx`（扩） — render `<PortHandles catchAll>` 时左侧多 1 个隐形 handle；不传不渲染；命中区与具名 handle z-index 不冲突（断言 DOM 顺序）。
- `packages/frontend/tests/canvas-connect.test.tsx`（新） — 模拟 `onConnect({ source, sourceHandle, target, targetHandle: '__inbound__' })` → `onChange` 收到带新 edge、`target.portName === sourceHandle`。catch-all + 已存在同名边 → 重复检测拒绝（不改 definition）。
- `packages/frontend/tests/canvas-edge-inspector.test.tsx`（新） — render 一个含 1 edge 的 definition，模拟选中 edge，改 target.portName 提交 → onChange 收到更新后 edges。改成已占用 portName 时 onChange 不被调用、显示冲突文案。
- `packages/frontend/tests/canvas-missing-refs.test.tsx`（新或扩 NodeInspector 单测） — agent node `promptTemplate='hi {{a}} {{b}}'`，无任何入边 → MissingRefList 显示 `[a, b]`；建一条 `target.portName='a'` 的边后 → 仅显示 `[b]`；模板没引用任何 `{{...}}` → 不渲染该行。

预估增量：

- 前端：~280 LoC（PortHandles +20、Canvas +60、EdgeInspector ~120、NodeInspector +30、selection 重构 ~30 + i18n 16 行 ~20）
- 测试：~260 LoC

## 3. PortHandles 改造

### 3.1 接口

```ts
interface Props {
  side: 'left' | 'right'
  ports: string[]
  /** When set, render an extra invisible target handle covering the full left edge.
   *  Only honored when side === 'left'. */
  catchAll?: { id: string }
}
```

### 3.2 渲染策略

```tsx
return (
  <div className={`canvas-node__ports canvas-node__ports--${side}`}>
    {side === 'left' && catchAll && (
      <Handle
        type="target"
        position={Position.Left}
        id={catchAll.id}
        className="canvas-node__handle canvas-node__handle--catchall"
        aria-hidden="true"
      />
    )}
    {ports.map((p, i) => { /* unchanged named handle */ })}
  </div>
)
```

CSS（`packages/frontend/src/styles.css` 末尾追加）：

```css
.canvas-node__handle--catchall {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  width: 12px !important;
  height: 100% !important;
  background: transparent !important;
  border: none !important;
  border-radius: 0 !important;
  /* xyflow draws the handle absolutely positioned by default; we
     stretch to a vertical strip so the user can drop anywhere on the
     left edge. Specific named handles render as small circles ON TOP
     of this strip — see z-index below. */
  z-index: 0;
}
.canvas-node__handle:not(.canvas-node__handle--catchall) {
  z-index: 1;
}
```

### 3.3 命中优先级

xyflow 把鼠标位置匹配到最近的 Handle DOM 元素（pointer-events / z-index 决定）。具名 handle 的小圆点 z-index=1 + 几何尺寸 8px 圆形，catch-all 是整条 12px 宽透明 strip z-index=0；当鼠标松手在小圆点 hit area 内 → 命中具名（U3 扇入）；否则命中 catch-all（U1 / U2 默认建边）。

测试断言这个 z-index 关系即可（DOM 类名顺序 + style.zIndex）；不模拟实际命中。

## 4. WorkflowCanvas onConnect 转译

`packages/frontend/src/components/canvas/WorkflowCanvas.tsx`：

```ts
const handleConnect = useCallback(
  (conn: Connection) => {
    if (readOnly === true || onChange === undefined) return
    // catch-all → derive target portName from source handle
    const targetHandle =
      conn.targetHandle === INBOUND_HANDLE_ID ? conn.sourceHandle : conn.targetHandle
    const built = buildEdgeFromConnection(definition, { ...conn, targetHandle })
    if (built === null) return
    onChange({ ...definition, edges: [...definition.edges, built] })
  },
  [definition, onChange, readOnly],
)
```

`buildEdgeFromConnection` 不变 —— 它已经做：

- 任一端缺 `nodeId` / `handle` → null（catch-all 转译之后 sourceHandle 也是字符串才可能转译，否则保持 null 让它拒掉）
- 自环 → null
- (source.nodeId+portName, target.nodeId+portName) 重复 → null

### 4.1 onEdgeClick / selection union

现在 `WorkflowCanvas` 的 `onSelect` 是 `(nodeId: string | null) => void`，只关心节点。升级为：

```ts
type CanvasSelection =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | null

interface WorkflowCanvasProps {
  // ...
  onSelect?: (sel: CanvasSelection) => void
}
```

在画布层：

```tsx
<ReactFlow
  // ... existing
  onEdgeClick={(_, edge) => {
    setSelection({ nodes: [], edges: [edge.id] })
    if (onSelect) onSelect({ kind: 'edge', id: edge.id })
  }}
  onSelectionChange={(s) => {
    // existing logic; if exactly one edge and zero nodes → emit edge selection
    // if exactly one node → emit node; otherwise null
    ...
  }}
/>
```

由 inspector 容器（编辑器路由）根据 `sel.kind` 渲对应 inspector pane，互斥。多选（>1 节点 / 1 节点+1 边）按现有"NodeInspector 显示首选节点"行为不变；本 RFC 仅扩展精确单选 edge 的路径。

## 5. EdgeInspector

`packages/frontend/src/components/canvas/EdgeInspector.tsx`（新）：

```tsx
interface Props {
  edge: WorkflowEdge
  definition: WorkflowDefinition
  onChange: (next: WorkflowDefinition) => void
  onClose?: () => void
}

export function EdgeInspector({ edge, definition, onChange, onClose }: Props) {
  const { t } = useTranslation()
  const [draftPort, setDraftPort] = useState(edge.target.portName)
  const [conflict, setConflict] = useState<string | null>(null)

  function commit() {
    const trimmed = draftPort.trim()
    if (trimmed === '' || trimmed === edge.target.portName) {
      setConflict(null)
      return
    }
    // Conflict: another edge with same source.nodeId+portName + same target.nodeId
    // and the new target.portName already exists.
    const dup = definition.edges.some(
      (e) =>
        e.id !== edge.id &&
        e.source.nodeId === edge.source.nodeId &&
        e.source.portName === edge.source.portName &&
        e.target.nodeId === edge.target.nodeId &&
        e.target.portName === trimmed,
    )
    if (dup) {
      setConflict(t('inspector.edgeConflictMsg'))
      return
    }
    setConflict(null)
    onChange({
      ...definition,
      edges: definition.edges.map((e) =>
        e.id === edge.id
          ? { ...e, target: { ...e.target, portName: trimmed } }
          : e,
      ),
    })
  }

  function remove() {
    onChange({
      ...definition,
      edges: definition.edges.filter((e) => e.id !== edge.id),
    })
    onClose?.()
  }

  return (
    <div className="form-grid">
      <h3>{t('inspector.edgeTitle')}</h3>
      <Field label={t('inspector.edgeSourceLabel')}>
        <code>{edge.source.nodeId}.{edge.source.portName}</code>
      </Field>
      <Field label={t('inspector.edgeTargetLabel')}>
        <code>{edge.target.nodeId}</code>
      </Field>
      <Field label={t('inspector.edgePortNameLabel')}>
        <TextInput value={draftPort} onChange={setDraftPort} onBlur={commit} />
        {conflict && <p className="error-box">{conflict}</p>}
      </Field>
      <button className="btn btn--danger btn--sm" onClick={remove}>
        {t('inspector.edgeDeleteBtn')}
      </button>
    </div>
  )
}
```

**关键不变量**：

- 改名仅在「新名 ≠ 原名 且非空」时尝试 commit；空字符串视为"未改"，不报错。
- 冲突仅检测「同 source 同 target.nodeId 同 target.portName」—— 与 `buildEdgeFromConnection` 的去重规则保持一致。
- 同 target.nodeId 上同 portName 但来自不同 source 不算冲突（U4 合法扇入合并）。
- onChange 写出后，`computePorts` 自动重算，`coder` 节点上原 portName 若没有任何 edge 引用则其具名 handle 自然消失。

## 6. NodeInspector — MissingRefList

放在 agent 分支 `<PortRefList>` 下方。逻辑：

```ts
const tokens = useMemo(() => {
  const re = /\{\{(\w+)\}\}/g
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = re.exec(promptTemplate)) !== null) {
    const name = m[1]
    if (name.startsWith('__')) continue // builtin meta like __repo_path__
    out.add(name)
  }
  return [...out]
}, [promptTemplate])

const inboundNames = new Set(ports.inputs)
const missing = tokens.filter((t) => !inboundNames.has(t))
```

UI：

```tsx
{missing.length > 0 && (
  <div className="inspector__port-refs">
    <span className="muted">{t('inspector.missingRefsLabel')}</span>{' '}
    <ChipsInput value={missing} onChange={() => {}} placeholder="" />
    <p className="muted" style={{ fontSize: 12 }}>{t('inspector.missingRefsHint')}</p>
  </div>
)}
```

> 这只是编辑期可视化辅助。最终拦截仍由 backend `workflow.validator.ts`（P-2-01）在 task 启动时把关。

i18n（zh-CN / en-US 双语对齐）：

| key | zh-CN | en-US |
| --- | --- | --- |
| `inspector.edgeTitle` | `边设置` | `Edge` |
| `inspector.edgeSourceLabel` | `源` | `Source` |
| `inspector.edgeTargetLabel` | `目标节点` | `Target node` |
| `inspector.edgePortNameLabel` | `目标端口名` | `Target port name` |
| `inspector.edgeConflictMsg` | `已存在同源同目标端口的边，请先删除。` | `An edge with the same source and target port already exists; remove it first.` |
| `inspector.edgeDeleteBtn` | `删除该边` | `Delete edge` |
| `inspector.missingRefsLabel` | `模板引用但未连入：` | `Template refs without inbound edge:` |
| `inspector.missingRefsHint` | `这些端口名出现在 prompt 模板里但没有上游边；启动 task 会被静态校验拦下。` | `These names appear in the prompt template but have no inbound edge; task launch will fail static validation.` |

## 7. Edge 选中 / 显示交互

编辑器路由（按现状最可能是 `routes/workflows.detail.tsx`，本 RFC 实施时确认）：

```tsx
const [selection, setSelection] = useState<CanvasSelection>(null)

return (
  <div className="editor">
    <WorkflowCanvas
      definition={def}
      agents={agents}
      onChange={save}
      onSelect={setSelection}
    />
    <Drawer>
      {selection?.kind === 'node' && (
        <NodeInspector node={findNode(def, selection.id)} ... />
      )}
      {selection?.kind === 'edge' && (
        <EdgeInspector edge={findEdge(def, selection.id)} definition={def} onChange={save} />
      )}
    </Drawer>
  </div>
)
```

`onSelect` 的语义：

- xyflow 触发 `onEdgeClick` → `WorkflowCanvas` 把 selection 设为该 edge，调用 `onSelect({kind:'edge', id})`。
- xyflow 触发 `onSelectionChange`（含 lasso / 多选）：
  - 1 node + 0 edge → `{kind:'node', id}`
  - 0 node + 1 edge → `{kind:'edge', id}`
  - 其他（多选 / 全空 / 混合）→ `null`（抽屉空）
- 既保持现有行为（NodeInspector 跟随首选节点），又把单选 edge 的路径连通。

## 8. 测试策略

### 8.1 单元

`canvas-port-handles.test.tsx`：

- case 1：`<PortHandles side="left" ports={[]} />` 渲 0 个 Handle。
- case 2：`<PortHandles side="left" ports={[]} catchAll={{id:'__inbound__'}} />` 渲 1 个 Handle，带 className `canvas-node__handle--catchall`。
- case 3：`<PortHandles side="left" ports={['a']} catchAll={{id:'__inbound__'}} />` 渲 2 个 Handle；catch-all 在 DOM 中位于具名 handle **之前**（兜底命中优先靠 z-index，但 DOM order 是回归断言）。
- case 4：`<PortHandles side="right" ports={['a']} catchAll={{id:'x'}} />` —— catch-all 不渲染（仅 left 才生效）。

`canvas-connect.test.tsx`：

- case 1：onConnect with `targetHandle === INBOUND_HANDLE_ID` 且 sourceHandle='req' → onChange 收到含新 edge 且 `target.portName === 'req'`。
- case 2：onConnect with named targetHandle 'foo' → 沿现有路径，`target.portName === 'foo'`。
- case 3：onConnect 同 INBOUND_HANDLE_ID 拖第二次相同源 → 第二次 onChange 不触发（重复）。
- case 4：onConnect 时 source===target → 不触发 onChange（自环）。

`canvas-edge-inspector.test.tsx`：

- case 1：渲 EdgeInspector，改 target.portName 触发 onBlur → onChange 收到对应 edge 更新。
- case 2：改成已占用 portName（同 source 同 target）→ onChange 不触发，显示 conflict 文案。
- case 3：改成空字符串 / 与原值相同 → onChange 不触发，无错误。
- case 4：点 Delete → onChange 收到 edges 缩短 1 条。

`canvas-missing-refs.test.tsx`：

- case 1：promptTemplate `Implement {{a}} {{b}}` + 入边 portName=`a` → MissingRefList 显示 `[b]`。
- case 2：promptTemplate `Implement {{__repo_path__}}` → builtin meta 不计入 missing。
- case 3：promptTemplate 没引用 `{{...}}` → MissingRefList 不渲染。
- case 4：所有引用都已连入 → MissingRefList 不渲染。

### 8.2 集成（轻量）

不新增 Playwright e2e；现有 e2e 跑一遍编辑器 happy-path 覆盖 regress（拖节点 / 重排不破坏）。

### 8.3 手工 QA checklist

1. 启动 dev server，打开任意已有 workflow（最好就是 `01KRN2AJT8JCPGX40QRGFVR700`）。
2. 拖一个 agent-single 节点上画布；agent frontmatter 确保有 `outputs:` 至少一项，方便测两端连接。
3. 从 input 节点 source handle 拖到该 agent 节点左侧空白处 → 边落地，左侧出现具名 handle。
4. 从另一个 source 拖入同一 agent 左侧空白 → 第二个具名 handle 并存。
5. 第三次相同 source+portName 拖到同名具名 handle → 第二条同名边落地，运行时拼接（不在本 RFC 跑 task，但 definition 里能看到两条同名边）。
6. 单击其中一条 edge → 抽屉切到 EdgeInspector，改 target.portName，保存 → 画布上 handle 名变化。
7. 改成已占用 portName → 看到红字提示，不写入。
8. NodeInspector 模板里写 `{{x}}` 但不连边 → MissingRefList 显示 `x`。

## 9. 兼容性 / 迁移

- 老 workflow 不需要迁移。`Edge` schema 不变。
- 老 workflow 含 `node.ports[]`（output 节点的 bindings）也不动 —— 本 RFC 不影响。
- 新建边的 default `target.portName = source.portName` 与已有 YAML 导入的边形态一致；导出 YAML 仍照旧。
- 回滚：删 catch-all 渲染 + 还原 onConnect / onSelect 接口 + 删 EdgeInspector 文件 → 完全回到 RFC 之前。

## 10. 已考虑、被否决的替代方案

- **方案 A：drop 时弹 popover 让用户填 target.portName**。最完整的 UX，但在 v1 之外引入额外组件 + 阻塞键盘焦点处理。本 RFC 选用「默认 portName=source.portName + EdgeInspector 改名」二段式，覆盖同样场景且改动量更小。
- **方案 B：解析 promptTemplate `{{xxx}}` 自动建 input port**。违反设计 §3.5「edge 是 input port 的唯一来源」，且无法表达"用户写错 / 还没写边"的状态。仅用作 MissingRefList 的可视化提示。
- **方案 C：不做 catch-all，改在节点 body click 弹"添加 input port"对话框**。绕开拖线天然语义；与 xyflow 的连线模型背道而驰；废弃。
- **方案 D：output 节点 / wrapper-loop outputBindings 也走 edge 路径**。改 bindings 模型范围太大，超本 RFC scope。

## 11. 参考

- WorkflowCanvas：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx`
- PortHandles：`packages/frontend/src/components/canvas/nodes/PortHandles.tsx`
- AgentNode / OutputNode / InputNode / WrapperNodes：`packages/frontend/src/components/canvas/nodes/`
- NodeInspector（PortRefList 出处）：`packages/frontend/src/components/canvas/NodeInspector.tsx:501`
- backend 静态校验：`packages/backend/src/services/workflow.validator.ts`
- 设计依据：`design/proposal.md` §3.5 / §4.2 / §4.3，`design/design.md` §5 / §7.3
