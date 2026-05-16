# RFC-015 Plan — Fanout sourcePort 拖拽实施计划

> 状态：Draft（2026-05-16）
> 关联：[proposal.md](./proposal.md)、[design.md](./design.md)
> PR 策略：**单 PR**。改动全部集中在 `packages/frontend/`，零 backend / shared / DB / runtime / migration。

## 1. 子任务

### RFC-015-T1：新建 `fanoutSourceSync` 纯函数模块

**文件**：

- `packages/frontend/src/components/canvas/fanoutSourceSync.ts`（新建）

**做什么**：

1. 导出常量 `MULTI_SOURCE_PORT_HANDLE_ID = '__multi_source_port__'`。
2. 导出 3 个纯函数（签名 + 实现见 design.md §4）：
   - `applySourcePortConnection(def, conn) → next def`
   - `clearSourcePortOnNodeRemoved(def, removed) → next def`
   - `isValidSourcePortConnection(def, conn) → boolean`
3. ref-equality 短路：所有 transform 在无实质变化时返回原 `def` 引用。
4. 仅依赖 `@xyflow/react` 的 `Connection` 类型与 `@aw/shared` 的 `WorkflowDefinition`；不引入 React / DOM。

**Size**：S（≈ 90 行 TS，1 常量 + 3 函数 + 内部类型 helper）

**Deps**：—

**Output**：单文件；typecheck / lint 全绿。

### RFC-015-T2：AgentNode fanout 分支渲染顶部 Handle

**文件**：

- `packages/frontend/src/components/canvas/nodes/AgentNode.tsx`
- `packages/frontend/src/components/canvas/nodes/types.ts`（追加 `data.sourcePort` 字段）

**做什么**：

1. `types.ts` 在 `CanvasNodeData` 接口尾部加 `sourcePort?: { nodeId: string; portName: string }`，注释说明只对 agent-multi 有意义。
2. `AgentNode.tsx`：import `Handle, Position, useUpdateNodeInternals` from `@xyflow/react`，import `MULTI_SOURCE_PORT_HANDLE_ID` from `../fanoutSourceSync`。
3. fanout 分支（`data.kind === 'agent-multi'`）：
   - `useUpdateNodeInternals(id)` + `useEffect([multi])` 切换 fanout 形态时触发 xyflow 重算 handle。
   - 在节点根 div 内最顶部 inline 一个 `<Handle type="target" position={Position.Top} id={MULTI_SOURCE_PORT_HANDLE_ID} ...>`。
   - className 按 `sourcePort.nodeId !== ''` 切 `is-connected`。
4. agent-single 分支不渲染该 handle、不调 useUpdateNodeInternals。
5. 不动 PortHandles 调用、不动既有 catch-all、不动节点 header / id 显示。

**Size**：S（≈ 25 行改动 + 1 字段加 types.ts）

**Deps**：T1

**Output**：fanout 节点顶部多一个 8×8 圆 handle，已连接态填充色不同。

### RFC-015-T3：WorkflowCanvas 接入 connect / validity / removal

**文件**：

- `packages/frontend/src/components/canvas/WorkflowCanvas.tsx`

**做什么**：

1. 顶部 import `applySourcePortConnection` / `clearSourcePortOnNodeRemoved` / `isValidSourcePortConnection` / `MULTI_SOURCE_PORT_HANDLE_ID` from `./fanoutSourceSync`。
2. `handleConnect`：在 RFC-007 既有 `viaCatchAll` 判定之前插入 fast-path：`if (conn.targetHandle === MULTI_SOURCE_PORT_HANDLE_ID) { ... return }`，详见 design §6.1。
3. `isValidConnection`：在既有 iterate 锁前调 `isValidSourcePortConnection`；非顶部 handle 永远返回 true，对 RFC-007 路径透明。详见 design §6.2。
4. `handleNodesChange`：commitChange 前对 `removed` 列表调 `clearSourcePortOnNodeRemoved`；ref-equality 短路保证无 fanout 节点受影响时零额外写。详见 design §6.3。
5. WorkflowCanvas 把 `node.sourcePort` 透传到 react flow node 的 `data.sourcePort`——找到既有把 `WorkflowNode` 翻译成 xyflow node 的位置（`toReactFlowNodes` 或 inline `useMemo`）。

**Size**：S（≈ 30 行改动 + 1 字段透传）

**Deps**：T1, T2

**Output**：拖到顶部 handle 写 sourcePort 字段；拖到左侧仍走 RFC-003/RFC-007；删除源节点级联清空 sourcePort；自环被拒。

### RFC-015-T4：CSS — `.canvas-node__handle--shard-source`

**文件**：

- `packages/frontend/src/styles.css`

**做什么**：

1. 加 `.canvas-node__handle--shard-source { ... }`：未连接态 dashed border + 中性色（`var(--muted)`）。
2. 加 `.canvas-node__handle--shard-source.is-connected { ... }`：填充色 `var(--accent)`、实线边。
3. 视觉与现有 `.canvas-node__handle` 既有形状一致（保 8×8 圆），仅改颜色与边框。
4. 不动 RFC-006 既有 port label / port-row / inbound-catchall 规则。

**Size**：XS（≈ 12 行 CSS）

**Deps**：—

**Output**：fanout 顶部 handle 视觉两态可识别。

### RFC-015-T5：inspector hint + i18n

**文件**：

- `packages/frontend/src/components/canvas/NodeInspector.tsx`
- `packages/frontend/src/i18n/zh-CN.ts`
- `packages/frontend/src/i18n/en-US.ts`

**做什么**：

1. NodeInspector agent-multi 分支 `<Field label={t('inspector.fieldSourcePort')}>` 内 `<SourcePortField>` 之后加一行 `<p className="muted" style={{fontSize:12,marginTop:4}}>{t('inspector.sourcePortDragHint')}</p>`。
2. i18n 中文加 `inspector.sourcePortDragHint: '也可以从节点顶部的端口直接拖入上游输出来设置。'`。
3. i18n 英文加 `inspector.sourcePortDragHint: 'You can also drag an upstream output onto the handle at the top of this node to set the source.'`。
4. 不动 `SourcePortField` 内部、不动两下拉框、不动 review/output 12 字段。

**Size**：XS（≈ 6 行改动 + 2 i18n key）

**Deps**：—

**Output**：抽屉里有"拖入也可"的引导文案。

### RFC-015-T6：单元测试 — `fanout-source-sync`

**文件**：

- `packages/frontend/tests/fanout-source-sync.test.ts`（新建）

**做什么**：

按 design.md §8.1 写 13 case：

- `applySourcePortConnection` × 6 case（fanout 写入 / agent-single 不动 / review 不动 / 非顶部 handle 不动 / 二次替换 / 同值 ref-equality）
- `clearSourcePortOnNodeRemoved` × 3 case（命中清空 / 不命中返回原 / 多删一遍清）
- `isValidSourcePortConnection` × 4 case（非顶部 true / 自环 false / target 非 fanout false / source 不存在 false）+ 1 case（合法 true）

文件顶部注释：链回 RFC-015 design §8.1，说明每条 case 锁的回归点。

**Size**：M（≈ 200 行测试）

**Deps**：T1

**Output**：vitest 13 case 全绿。

### RFC-015-T7：JSDOM 集成测 — Canvas 连接路径

**文件**：

- `packages/frontend/tests/canvas-fanout-source-port-drag.test.tsx`（新建）

**做什么**：

按 design.md §8.2 写 5 case：

1. 渲染 fanout 节点 → DOM 含 `Handle[id="__multi_source_port__"]`。
2. 调 onConnect 到顶部 handle → 字段写入 + edges 不变。
3. 二次 onConnect 不同 source → sourcePort 替换。
4. 调 onConnect 到 catch-all → edges +1 + sourcePort 不动。
5. 调 onNodesChange 删源节点 → 字段被清空。

走 React Testing Library 渲染 `<WorkflowCanvas>`，调 props 模拟事件（不模拟真实 DOM 拖拽）。

**Size**：M（≈ 180 行测试）

**Deps**：T2, T3

**Output**：vitest 5 case 全绿。

### RFC-015-T8：源代码层兜底测

**文件**：

- `packages/frontend/tests/canvas-fanout-source-port-not-floating.test.ts`（新建）

**做什么**：

按 design.md §8.4：

- fs.read + 正则锁定 5 个文件的标志性符号：
  - `AgentNode.tsx`：`__multi_source_port__` + `Position.Top` + `type="target"` + `canvas-node__handle--shard-source`
  - `fanoutSourceSync.ts`：4 个 export 符号字面量
  - `WorkflowCanvas.tsx`：`from './fanoutSourceSync'` + 3 函数调用
  - `styles.css`：`.canvas-node__handle--shard-source` + `.canvas-node__handle--shard-source.is-connected`
  - `i18n/zh-CN.ts` + `i18n/en-US.ts`：`sourcePortDragHint`
- 文件顶部注释链回 RFC-015 + commit hash placeholder `<TBD-commit-hash>`（合并后回填）。
- 说明 JSDOM 无 layout / xyflow drag 测试代价高，源码层兜底必要。

**Size**：S（≈ 80 行）

**Deps**：T1-T5

**Output**：vitest 全绿；任何未来 refactor 删常量 / 删 import / 删 i18n key 都被锁红。

### RFC-015-T9：（可选）e2e

**默认不做**。理由：xyflow 在 Playwright 上的 drag-drop 模拟代价高（前序 RFC-007 同样选择 skip e2e）；本 RFC 所有 contract 已被 JSDOM 集成 + 源代码层兜底覆盖。CI 既有 e2e 矩阵照常跑保 RFC-006 / RFC-007 不退化即可。

**Size**：—

**Deps**：—

**Output**：—

## 2. PR 拆分建议

**单 PR**。范围：

| 类型 | 文件                                                                                                               | 数量 |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---- |
| 新建 | `fanoutSourceSync.ts` / 3 个测试文件                                                                               | 4    |
| 改动 | `AgentNode.tsx` / `types.ts` / `WorkflowCanvas.tsx` / `NodeInspector.tsx` / `styles.css` / `zh-CN.ts` / `en-US.ts` | 7    |
| 文档 | `STATE.md` / `design/plan.md`（RFC 索引追加 + 进行中标记移除）                                                     | 2    |

理由：

- 全部改动在 frontend 单 layer，无跨包依赖、无 backend / DB / shared 触碰。
- T1 是新文件无 break risk；T2-T5 都依赖 T1 但互相独立；测试 T6-T8 在前序合并后立刻可绿。
- 单 PR 在 `git revert` 上最简洁；任何拆分都引入"中间态"风险（如先合 T2 不合 T3 → 节点顶部有 handle 但拖上去没反应，体验更差）。

commit message 模板：

```
feat(canvas): RFC-015 fanout 节点支持拖拽指定 sourcePort

- 新 fanoutSourceSync 纯函数模块：MULTI_SOURCE_PORT_HANDLE_ID 常量 +
  applySourcePortConnection / clearSourcePortOnNodeRemoved /
  isValidSourcePortConnection 三函数，全部 ref-equality 短路
- AgentNode fanout 分支在节点顶部 inline <Handle type="target"
  position="top" id="__multi_source_port__">，连接态 className 切换
  is-connected 视觉差异化；useUpdateNodeInternals 在 single↔multi
  切 kind 时触发重算
- WorkflowCanvas.handleConnect 入口 fast-path 命中顶部 handle 写
  node.sourcePort 字段，不进 edges[]；isValidConnection 加自环 /
  target 非 fanout / source 不存在三守护；handleNodesChange 删节点
  时级联清空 fanout.sourcePort
- NodeInspector agent-multi 分支追加 muted hint 引导拖拽路径
- CSS .canvas-node__handle--shard-source 两态视觉

测试 +18：fanout-source-sync 13 case 纯函数；
canvas-fanout-source-port-drag 5 case JSDOM 集成；
canvas-fanout-source-port-not-floating 源代码层兜底锁标志符号
```

## 3. 验收清单

- [ ] T1 `fanoutSourceSync.ts` 文件 + 4 export
- [ ] T2 AgentNode fanout 分支渲染 `__multi_source_port__` Handle
- [ ] T3 WorkflowCanvas `handleConnect` / `isValidConnection` / `handleNodesChange` 三处接入
- [ ] T4 CSS `.canvas-node__handle--shard-source` 两态
- [ ] T5 inspector hint + 2 i18n key
- [ ] T6 fanout-source-sync.test.ts 13 case 全绿
- [ ] T7 canvas-fanout-source-port-drag.test.tsx 5 case 全绿
- [ ] T8 源代码层兜底测全绿
- [ ] proposal §4 验收标准 10 条全部映射到测试 ID
- [ ] `bun run typecheck && bun run test && bun run format:check` 全绿
- [ ] push 后 GitHub Actions 矩阵全绿（含 build-binary + Playwright e2e）按 [feedback_post_commit_ci_check] 复查
- [ ] STATE.md "已完成 RFC" 表追加 RFC-015 行（status Done）
- [ ] design/plan.md RFC 索引 status 从 Draft 改 Done
- [ ] STATE.md 顶部 "进行中 RFC" 移除 RFC-015 行

## 4. 风险点速查

- **fast-path 误判**：`handleConnect` 顶部 fast-path 必须严格判 `targetHandle === MULTI_SOURCE_PORT_HANDLE_ID`，与 RFC-003 `__inbound__` 字面量字面隔离。验收 T7 case 4 锁。
- **`useUpdateNodeInternals` 漏调**：用户在 single ↔ multi 切 kind 时 handle 出现 / 消失需要 xyflow 重新计算锚点。验收 T7 case 1 + JSDOM `rerender({kind:'agent-multi'})` 流程兜底（必要时补一个 case）。
- **删除级联漏触发**：`handleNodesChange` 必须从 `changes` 数组里准确收集 `type:'remove'` 的 ids，且在 `commitChange` 前做清扫；ref-equality 保证无 fanout 被影响时不额外触发 commit。验收 T6 + T7 case 5。
- **CSS 视觉漂移**：`.is-connected` 取色用 `--accent` 与 既有 review / EdgeInspector 配色一致，避免引入新色板。

## 5. 与其他 RFC 的协调

- 与 RFC-003（catch-all）：fanout 顶部 handle 与左侧 catch-all 是**双轨独立入口**，`handleConnect` 内严格 `if/else` 互斥；catch-all 入边语义与 prompt 模板 `{{port}}` 解析行为完全不变。
- 与 RFC-006（PortHandles 行内化）：本 RFC 不动 PortHandles 任何分支，顶部 handle 是 inline `<Handle>`；视觉位置 `Position.Top` 在节点 header 上方，不与左右两侧 port row 重叠。
- 与 RFC-007（review/output 拖拽 + connectionSync）：本 RFC 在 `handleConnect` 内以 fast-path 先于 RFC-007 路径判定，互相不感知；新模块 `fanoutSourceSync.ts` 与 `connectionSync.ts` 平行（不复用、不修改），保持职责清晰。
- 与 RFC-014（iterate sibling regen）：本 RFC 与 review 节点的 `inputSource` 字段无交集，sourcePort 是 agent-multi 专有字段。

## 6. 完工后动作

1. 在 STATE.md "已完成 RFC" 表追加 RFC-015 行（关键产出栏简述本 RFC 落地内容）。
2. design/plan.md RFC 索引 status 改 Done。
3. STATE.md 顶部移除 "进行中 RFC：RFC-015" 标记。
4. 按 [feedback_post_commit_ci_check]：推 push 后立刻 `gh run list -L 5` 查 CI 状态，全绿确认。
