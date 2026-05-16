# RFC-016 Design — 包装器交互重构：技术设计

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 修订基线：design/design.md §5 / §7.4

## 1. Schema 决断：保留 `wrapper.nodeIds` 作为唯一真理源

- **不引入** 子节点 `parentNodeId` 字段，**不 bump** `WorkflowDefinition.$schema_version`。
- wrapper 节点新增 optional pass-through 字段 `size: { width: number; height: number }`（写入由 auto-fit 或用户手动 resize 触发，缺省时渲染期临时计算）。
- 子节点 position 在 DB 永远是**绝对画布坐标**——xyflow `parentId` 投影要求的"相对坐标"只发生在 `definitionToXyflow` / `xyflowToDefinition` 两个纯函数里，DB schema 永远拿到的是绝对坐标。
- 由此带来的所有边界：
  - backend `services/scheduler.ts` 零改动（仍读 `wrapper.nodeIds`）。
  - backend `services/workflow.validator.ts` 零必改（现有 wrapper-required / wrapper-loop-\* 规则继续工作）；新增 1 条 warning（详见 §6）。
  - backend `services/workflow.yaml.ts` 零必改（`size` 是 pass-through）。
  - DB drizzle migration 0 条。

### 1.1 wrapper.size 字段语义

- `size: { width, height }` optional：
  - **缺省**：渲染期由 `computeFitBounds(wrapper, childNodes)` 算出尺寸，**不** 自动写回 DB（避免"打开旧 workflow 就 dirty"），仅在用户首次有意操作（增 / 删 / 拖 / 改字段）触发 commitChange 时写入 wrapper.size。
  - **已有值**：直接采用作为渲染尺寸；自动 fit 仅在以下两条路径触发——(a) 增 / 删 inner 节点；(b) 右键 → Fit to children。**不** 在普通的 inner 节点移动上自动 fit（避免抖动）。
  - **用户手动 resize**：通过 xyflow `<NodeResizer>` 拖角点；resize 结束后 wrapper.size 锁定为用户值，下次增 / 删 inner 节点不再自动 fit，除非用户主动点 Fit to children。
- 最小尺寸：200×120（空容器）；padding 24px 四向；wrapper header 22px 高（与现有 `.canvas-node__header` 对齐）。

## 2. 状态机：归属边界检测与互斥更新

### 2.1 纯函数 `resolveMembershipOnDragStop`

签名：

```ts
function resolveMembershipOnDragStop(args: {
  draggedNodeId: string
  draggedCenter: { x: number; y: number } // 已转为绝对画布坐标
  wrappers: Array<{ id: string; rect: Rect; nodeIds: string[] }>
}): { joinWrapperId: string | null; leaveWrapperId: string | null }
```

规则（按顺序短路）：

1. 若 draggedNodeId 自身是 wrapper：先排除"自我命中"，再走 #2/#3。
2. 命中检测：从 `wrappers` 中找 **最内层** 包含 draggedCenter 的 wrapper（嵌套时按 wrapper rect 面积升序取最小）。
3. 计算 `currentWrapperId`：当前 wrappers 中谁的 nodeIds 已含 draggedNodeId（O(n) 扫描即可，wrapper 数量个位数）。
4. 输出：
   - `joinWrapperId = hitWrapper?.id ?? null`
   - `leaveWrapperId = currentWrapperId ?? null`
   - 若两者相等（命中即当前 wrapper），都置为 null —— 不需要 patch。

### 2.2 纯函数 `applyMembershipPatch`

签名：

```ts
function applyMembershipPatch(
  def: WorkflowDefinition,
  patch: { draggedNodeId: string; joinWrapperId: string | null; leaveWrapperId: string | null },
): WorkflowDefinition
```

实现：

- 若 leaveWrapperId 非 null：在 `def.nodes` 中找到对应 wrapper、从 nodeIds 移除 draggedNodeId。
- 若 joinWrapperId 非 null：找到对应 wrapper、追加 draggedNodeId（去重）。
- 两者均空：返回原 def（reference equality 维持，避免触发 RFC-003 的 1s auto-save 循环）。
- 受影响 wrapper 同时清空 `size`（让下次 fit 重新算）——除非用户已手动 resize 过（通过 `wrapper.sizeLocked: true` 标记，见 §1.1）。

### 2.3 嵌套同步

- 当 draggedNodeId 本身是 wrapper（嵌套移动）：递归确保该 wrapper 的所有 inner 节点跟随移动；xyflow `parentId` 投影原生处理画布层的视觉同步，schema 层 wrapper.nodeIds 不需要重计算（嵌套是"loop.nodeIds = [git.id]"+"git.nodeIds = [a,b]"两层独立结构）。
- 命中检测在嵌套时按"最内层"取——把 git wrapper 拖进 loop wrapper 时，loop 是命中目标；把 git wrapper 拖进**另一个** loop wrapper 时，从原 loop.nodeIds 移除、加新 loop.nodeIds，git 自己的 nodeIds 不变。

## 3. xyflow 渲染层：group 节点 + 子节点 parentId 投影

### 3.1 新组件 `GroupWrapperNode`

替换现有 `GitWrapperNode` / `LoopWrapperNode` 两个独立组件，**统一为一个** `GroupWrapperNode`，按 `data.wrapperKind` 分支渲染颜色 / pill / 是否显示 catch-all 入端口。理由：

- 两类 wrapper 视觉布局 80% 相同（容器矩形 + header + pill + 内部子节点投影）。
- 现有两组件的差异仅在 header 文案 + 颜色 + 左侧 input port 渲染——用 `wrapperKind` 数据分支收敛到一处更易维护。

JSX 大致：

```tsx
<div
  className={`canvas-node--wrapper-group canvas-node--wrapper-group--${kind}`}
  data-status={data.status ?? 'default'}
  style={{ width, height }} // 来自 wrapper.size 或 computeFitBounds
>
  <div className="canvas-node__header">
    <span className="canvas-node__kind">
      {kind === 'git' ? '⎈' : '⟳'} {label}
    </span>
    <WrapperHeaderPill kind={kind} data={data} />
  </div>
  {/* loop wrapper 保留 catch-all 入端口；不再渲染 named input ports（见 §4.4） */}
  {kind === 'loop' && <CatchAllInbound id={INBOUND_HANDLE_ID} />}
  <PortHandles side="right" ports={data.outputPorts} />
</div>
```

inner 子节点**不**在 GroupWrapperNode 内部渲染——xyflow 通过 `parentId` 把子节点 z-index 自动叠在 group 上，画布层级由 xyflow 管理（与平铺普通节点一样的渲染管线）。

### 3.2 `definitionToXyflow` 纯函数

签名：

```ts
function definitionToXyflow(def: WorkflowDefinition): { nodes: Node[]; edges: Edge[] }
```

新增 / 修改逻辑：

1. 先遍历 wrapper 节点，建一个 `Map<innerId, wrapperId>`（用于反查每个子节点的 parent；空 wrapper 也建 entry 以让 xyflow 知道 group 存在）。
2. 对每个 wrapper 节点：
   - xyflow `Node.type = 'wrapperGroup'`（注册到 `nodeTypes` 字典）。
   - `Node.position` = wrapper 绝对坐标。
   - `Node.style = { width: w, height: h }`（来自 wrapper.size 或 `computeFitBounds`）。
   - `Node.zIndex = -1`（让 group 在视觉上"压在"子节点之下；xyflow 默认 group 走更低的 z-layer）。
3. 对每个非 wrapper 节点：
   - 若该节点 id 出现在某 wrapper.nodeIds 中：`Node.parentId = wrapperId`、`Node.extent = 'parent'`、`Node.position = 绝对坐标 - wrapper 绝对坐标`（投影到相对）。
   - 否则按现有逻辑直出绝对坐标。

### 3.3 `xyflowToDefinition` 纯函数

签名：

```ts
function xyflowToDefinition(
  prev: WorkflowDefinition,
  nodes: Node[],
  edges: Edge[],
): WorkflowDefinition
```

落地核心：

- 对带 `parentId` 的子节点：position = `Node.position + parentWrapper.position`（投影回绝对）。
- 对 wrapper 节点：`size = Node.style 取出 width/height`（resize 后由 NodeResizer 写入）；如果是自动 fit 期则 size 不写（参 §1.1）。
- wrapper.nodeIds 不在此处重算——它的真理源是 `applyMembershipPatch` 在拖拽结束时直接写定义。

### 3.4 `computeFitBounds` 纯函数

签名：

```ts
function computeFitBounds(
  wrapper: { id: string; position: XY; nodeIds: string[] },
  allNodes: WorkflowNode[],
  padding: number = 24,
): { width: number; height: number; offset: XY }
```

- 取 wrapper.nodeIds 对应节点的 bbox（每个节点尺寸用平台已有的 `NODE_BBOX_BY_KIND` 表估算——agent / input / output / review 默认 240×120，嵌套 wrapper 用其 size）。
- 若 nodeIds 为空：返回最小 `{ width: 200, height: 120, offset: { x: 0, y: 0 } }`。
- 否则：`width = max(200, bbox.width + padding * 2)`、`height = max(120 + 22, bbox.height + padding * 2 + 22)`（22 是 header 高）。
- `offset`：当 inner 节点 bbox 的左上角不等于"wrapper.position + (padding, padding + 22)"时，渲染层把 wrapper 的画布锚点调整到 offset 处（让 inner 节点呈现在容器内部 padding 之内）；offset 不写回 DB，仅渲染期生效。

## 4. 交互细节

### 4.1 拖动结束钩子接入

- `WorkflowCanvas` 已有 `onNodeDragStop`（来自 RFC-003 / RFC-006 渲染管线）：在该 handler 内对**每一个** 被拖动节点调用 `resolveMembershipOnDragStop` + `applyMembershipPatch`，再走 `commitChange(next)`。
- xyflow 多选拖动场景：拖一组节点时按 batch 处理——逐一计算 join/leave，再合并成单次 `commitChange`，避免触发 1s auto-save 的连发 PUT。

### 4.2 拖入 wrapper 时的视觉反馈

- xyflow `onNodeDrag`（连续 fire）期间：若候选 hitWrapperId 存在则给该 wrapper 加 className `.canvas-node--wrapper-group--drop-hover`（CSS：`background-color` 切到 `--accent-muted` 更浅一档 + `border-color` 切到 `--accent`）；拖动结束（drop 或离开）后移除。
- 拖出当前 wrapper 时（鼠标离开矩形）：当前 wrapper 加 `.canvas-node--wrapper-group--leave-hint`（border-color 变虚线红），暗示松手即移除归属——避免误操作。

### 4.3 Resize 行为

- 启用 xyflow 内置 `<NodeResizer>`（v12 已有）：仅在 wrapper 被 selected 时显示 4 个角点。
- `onResize` 派发实时尺寸更新（节流到 60fps），松手时 `commitChange` 把 `size` + `sizeLocked: true` 写回。
- 用户右键 → Fit to children：调 `computeFitBounds` 重算 + 清除 `sizeLocked`。

### 4.4 loop wrapper 的左侧 named input port —— 移除

**当前 LoopWrapperNode 渲染 `PortHandles side="left" ports={data.inputPorts}`**——这些 named input port 在 backend `services/scheduler.ts` 的执行模型里**没有运行期语义**（调度器只看 wrapper.nodeIds 内的边）。它们存在的唯一用途是 RFC-003 catch-all 兜底拖拽时落到的"假"端口。

本 RFC 决断：

- **移除** loop wrapper 的 named input port 渲染（即去掉 `PortHandles side="left"` 调用）。
- **保留** catch-all `INBOUND_HANDLE_ID` 在 loop wrapper 上（RFC-003 兜底逻辑：用户从一条边拖到 wrapper header 时，仍会把这条边重定向到 wrapper 内某个有具名 left handle 的子节点——具体重定向语义在 RFC-003 §3 已定，本 RFC 不动）。
- **git wrapper** 已经没有 left handle，保持现状。

### 4.5 右键菜单 / 工具栏

- wrapper 右键菜单项（新）：
  - `Open Inspector`（即"切到 Inspector 该 wrapper tab"，与点节点效果同）。
  - `Fit to children`（强制 fit；清 sizeLocked）。
  - `Unwrap`（即现有 `decomposeWrapper`，文案改名）。
  - `Delete wrapper and inner nodes`（**新增**：连同 inner 一起删，与 Unwrap 互补；二次确认 dialog 防误删）。
- 框选 → 右键 → wrap selection 保留（既有 `wrapSelection` 行为）。
- header pill：见 proposal §2.1 #3。

## 5. Inspector：loop 表单候选式重写

### 5.1 候选源派生

新纯函数 `loopMemberCandidates`：

```ts
function loopMemberCandidates(
  wrapper: WorkflowNode, // wrapper-loop
  allNodes: WorkflowNode[],
  agents: AgentSummary[], // from /api/agents
): Array<{ nodeId: string; title: string; outputPorts: string[] }>
```

- 取 wrapper.nodeIds 对应的 inner 节点（排除嵌套 wrapper——loop 的退出条件不应直接引用 inner wrapper 的输出，因 wrapper-loop / wrapper-git 的对外输出走 outputBindings 路径）。
- 对每个 agent 节点：title = agent.title || agentName；outputPorts = 该 agent 在 agents API 中声明的 outputs[].name；若 agent 缺 outputs 声明则回退到 `['out']`。
- 对每个 review 节点：title = review.title || `review:${source.portName}`；outputPorts = `['output']`。

### 5.2 Inspector UI

- `exitCondition.nodeId`：`<select>` options 用 `loopMemberCandidates` 派生；展示 "title (nodeId)" 两段式。
- `exitCondition.portName`：依赖 exitCondition.nodeId 的选中值动态过滤候选 outputPorts；若 nodeId 改了 portName 但保留了旧 value 也展示红字 hint "端口已不存在"。
- `exitCondition.value` / `n` / `separator`：维持现有 input。
- `outputBindings`：每个 binding 行的 `bind.nodeId` / `bind.portName` 两 input 各改成 select，候选源同上。
- 新增 i18n key：`inspector.loopExitNodeIdSelect` / `inspector.loopExitPortNameSelect` / `inspector.loopExitInvalidNodeId` / `inspector.loopExitInvalidPortName` / `inspector.loopBindingInvalid` 中英各 5 条。

## 6. Validator：新增 1 条 warning

新 rule `wrapper-children-outside-bounds`（severity: warning）：

- 触发条件：wrapper.size 存在 + 某 inner 节点位置不在 wrapper rect (position + size) 内。
- 文案：`wrapper '${wrapperId}' contains inner node '${innerId}' positioned outside its visual bounds — fit to children to fix`。
- 来源：典型场景是 YAML 手编后 size 与 nodeIds 位置脱节。
- ValidationPanel 渲染时为该 warning 提供一个 "Auto-fit" 链接（点击 = 调 `computeFitBounds` 写回 + 清 sizeLocked + 触发 auto-save）。

不引入新 error 规则——本 RFC 的产品语义是"画布交互更友好"，不是"更严格"。

## 7. CSS 改动

`packages/frontend/src/styles.css`：

- 新增：
  - `.canvas-node--wrapper-group { background: var(--panel-subtle); border: 1px dashed var(--accent-muted); border-radius: 8px; padding: 0; }`
  - `.canvas-node--wrapper-group--git { background-color: rgba(56, 90, 130, 0.04); border-color: rgba(56, 90, 130, 0.6); }`
  - `.canvas-node--wrapper-group--loop { background-color: rgba(110, 70, 130, 0.04); border-color: rgba(110, 70, 130, 0.6); }`
  - `.canvas-node--wrapper-group--drop-hover { background-color: rgba(56, 90, 130, 0.12) !important; }`
  - `.canvas-node--wrapper-group--leave-hint { border-style: dotted; border-color: var(--danger); }`
  - `.wrapper-header-pill { font-size: 11px; padding: 2px 6px; border-radius: 4px; background: var(--bg); cursor: pointer; }`
- 删除（按 C3 兜底测试断言）：
  - `.canvas-node--wrapper { ... }`（旧 240px 卡片基底）
  - `.canvas-node--wrapper-git { ... }`、`.canvas-node--wrapper-loop { ... }`（旧两套独立样式）
- 保留：
  - `data-status` 三态点规则（与一般节点共用）继续生效。
  - 现有 PortHandles 相关样式 100% 保留（RFC-006 锁定）。

## 8. 测试策略

详见 plan.md。要点：

- 优先纯函数测：`resolveMembershipOnDragStop` / `applyMembershipPatch` / `definitionToXyflow` / `xyflowToDefinition` / `computeFitBounds` / `loopMemberCandidates`——这些是新逻辑的可断言面，覆盖率优先。
- 渲染层用 React Testing Library 跑 GroupWrapperNode + WorkflowCanvas mock；JSDOM 不跑 layout，所以拖入/拖出的命中检测**不**走真实 bounding box，而是直接用 `resolveMembershipOnDragStop` 纯函数测；视觉边界用源代码层断言（参 RFC-006 C3 模式）兜底。
- e2e（Playwright）扩 main.spec.ts step：画 git wrapper → 拖 agent 进去 → 跑 stub 任务 → task 详情画布断言"wrapper 矩形 + inner agent 节点 inside its rect"（用 `getBoundingClientRect` 比较，1px slack）。

## 9. 兼容性 / 迁移

- DB / migration：0 条。
- 老 workflow（含 nodeIds 但无 wrapper.size）：渲染期 `computeFitBounds` 临时算尺寸；首次 user-initiated commit 才写 size 字段。
- YAML 导入 / 导出：`size` 是 pass-through optional 字段——导出时若存在则写，缺省则不写（不强制添加，保留 YAML 整洁性）。
- task 详情画布（`tasks.detail.tsx`）：直接复用同一 `WorkflowCanvas` readOnly，渲染受益、零额外改动。
- 旧 `decomposeWrapper` 函数：保留为 `Unwrap` 内部实现，仅文案改名。

## 10. 风险与回退

- **风险 1：xyflow `parentId` + `extent: 'parent'` 在嵌套深度 > 2 时的相对坐标投影出错**——
  - 缓解：写 `definitionToXyflow` / `xyflowToDefinition` 时显式按"父链向上累加 offset"实现，而非依赖 xyflow 内部坐标系；测试覆盖 git inside loop inside loop 三层嵌套 case。
- **风险 2：用户在画布上误把节点拖入 wrapper（命中边缘判定）**——
  - 缓解：拖动期间 `--drop-hover` 视觉反馈让用户可视化目标 wrapper，松手前可看到提示；命中规则用"中心点"而非"任意一点"减少边缘抖动。
- **风险 3：自动 fit 与用户手动 resize 互斥规则被滥用导致尺寸抖动**——
  - 缓解：sizeLocked 标志位明确锁定语义；普通节点移动不触发 fit。
- **回退路径**：本 RFC 全为前端渲染层改动，schema 零回写、backend 零改动；若上线后发现严重交互问题，可在 1 个 PR 内把 GroupWrapperNode 切回旧 GitWrapperNode / LoopWrapperNode 两组件，wrapper.size 字段保留为无用数据不影响读路径。
