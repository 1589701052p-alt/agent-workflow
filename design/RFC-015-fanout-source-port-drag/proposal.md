# RFC-015 Proposal — Fanout（agent-multi）节点支持拖拽指定 sourcePort

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 修订基线：[RFC-003](../RFC-003-canvas-input-port-wiring/proposal.md) / [RFC-006](../RFC-006-node-port-ux-cleanup/proposal.md) / [RFC-007](../RFC-007-canvas-review-output-drag/proposal.md)

## 1. 背景

`agent-multi`（fanout / 多进程）节点的"分片来源"是一个语义上**独立于普通输入边**的字段 `node.sourcePort = {nodeId, portName}`：

- **scheduler 直接读字段**（`packages/backend/src/services/scheduler.ts:737`）取得分片来源、`pickLatestSourceRun` 找上游 run、按 sharding 策略切分。
- **validator** 单独跑 `agent-multi-source-port-missing` / `-invalid` 规则（`packages/backend/src/services/workflow.validator.ts:280-313`）。
- **dep graph 合成依赖**：scheduler 在 `:1320` 把 `sourcePort.nodeId → multi-node` 注入 DAG，**不存在于 `definition.edges[]`**。
- **prompt 模板兜底**：validator `:520-528` 把 `sourcePort.portName` 也算作 inbound port，让 `{{port_name}}` 在 prompt 里可引用——但这条"port name 兜底"行为不依赖任何边的存在。

也就是说 `sourcePort` 是 fanout 节点的一个**独立顶级字段**，跟 `edges[]` 完全平行。

编辑器今天的现实：用户配 `sourcePort` 必须打开右侧抽屉 → 在 `SourcePortField`（`packages/frontend/src/components/canvas/NodeInspector.tsx:858-933`）的两个串联下拉框里，**先选源节点 id**、**再从源节点 outputs 里选 port**。而 RFC-003 已经把 catch-all 拖拽行为做进了 agent 节点：用户的直觉是"拽一条线就够了"——但这条线只会写 `edges[]`、不会动 `sourcePort`，导致 fanout 节点的 sharding 来源始终空着。

### 1.1 直接成本

- **拖拽不工作**：用户拖完线视觉上有边，但 `sourcePort` 仍空，`validator` 抛 `agent-multi-source-port-missing`，任务启不来。然后用户去翻抽屉 → 找不到为什么——边明明都拖好了。
- **抽屉表单是"唯一可走路径"**：与 agent-single / loop / output（RFC-007 落地后）等节点的拖拽 UX 不一致，认知断层。
- **现有 RFC-003 catch-all 在 fanout 上职责模糊**：catch-all 接受任何源节点拖入并写 `edges[]`，但 fanout 节点上 catch-all 的入边除了喂给 prompt 模板的 `{{port}}` 引用外几乎没用——而真正决定 sharding 的 `sourcePort` 反而拖不到。

### 1.2 为什么是现在

- RFC-006 已经把 PortHandles 行内化、节点头部留出干净的视觉锚点空间，本 RFC 在节点顶部加一个专用 handle 不再受旧 strip 布局约束。
- RFC-007（review/output 拖拽连线）已经把 "拖拽 ↔ 字段双向同步" 的纯函数 + onCommitDef 套路打通；本 RFC 复用同一套手法（`connectionSync` 模块若 RFC-007 先合则直接扩，否则两 RFC 独立各自纯函数）。
- 用户最近反馈 fanout 的配置门槛过高，正适合让编辑路径与其它节点对齐。

### 1.3 本 RFC 不动哪些地方

- **不动 schema / scheduler / validator / runtime / DB**：`sourcePort` 仍是 `agent-multi` 节点的独立字段，scheduler 仍按字段取值，validator 仍跑既有规则。本 RFC 只让前端编辑器把"拖拽顶部 handle" → "字段写入"打通。
- **不动 `definition.edges[]` 语义**：拖到顶部 sourcePort handle **不产生**普通入边；拖到左侧 catch-all / 具名输入仍按 RFC-003 现状写 `edges[]`。两条路径并行存在、互不替代。
- **不动 RFC-003 catch-all 行为**：fanout 节点的左侧 catch-all 不被本 RFC 改造；普通入边仍可走 catch-all，喂 prompt 模板 `{{port_name}}` 引用。
- **不动 RFC-006 行内 PortHandles 布局**：顶部 handle 是新 inline `<Handle>`（不走 PortHandles），垂直布局上独立于左右两侧端口列。
- **不引入新节点种类 / 新 schema 字段 / 新 i18n 命名空间**：i18n 仅复用 `inspector.sourcePort*` 既有 key + 必要时新增 2-3 条 `inspector.sourcePortDragHint` 文案。
- **不动 task 详情画布的 read-only 行为**：read-only 模式既不能拖拽编辑、也不需要锁。
- **不引入"多 sourcePort"**：fanout 仍是单 sourcePort 语义。新拖入直接替换旧的（用户拍板的"唯一输入"语义）。

## 2. 目标

### 2.1 做

1. **agent-multi 节点新增顶部专用 target Handle**（id 固定为 `__multi_source_port__`），位于节点顶部居中，视觉上与左侧"普通输入区"明确区分（不同颜色 / 不同 className `canvas-node__handle--shard-source`）。Handle 渲染走 inline `<Handle>`（不走 PortHandles，避免给 PortHandles 加新分支）。
2. **canvas connect 命中顶部 handle 时写字段、不写边**：`handleConnect` 检测到 `targetHandle === '__multi_source_port__'` → **直接写 `node.sourcePort = {nodeId: src.nodeId, portName: src.sourceHandle}`**，**不**调用 `buildEdgeFromConnection`、**不**追加到 `definition.edges[]`；若 `sourcePort` 已有值，**静默替换**（"唯一输入、新拖入替换旧的"用户拍板）。
3. **canvas connect 命中左侧 catch-all / 具名输入 handle 时仍走 RFC-003**：`translateInboundConnection` + `buildEdgeFromConnection` 行为完全不动；agent-multi 节点上左侧的普通入边仍是普通 edges[]（用于 prompt 模板 `{{port}}` 引用）。
4. **`isValidConnection` 守护**：（a）顶部 sourcePort handle 拒绝以 fanout 节点自身为源的自环；（b）拒绝 source 节点不存在 outputs 时落上去（与 RFC-003 现有自环守护一致风格）。**不**要求源 port 的 `kind` 必须为 markdown/markdown_file；scheduler 不挑 kind，本 RFC 不引入新约束。
5. **canvas 删除 / 节点级联删除时的 sourcePort 清理**：选中边按 Delete 与本 RFC 无关（顶部 handle 拖入不产生 edge，没边可删）；但**若 sourcePort 指向的源节点被删除**（cascade-delete-node 路径）→ 自动把 fanout 节点的 `sourcePort` 字段清空（`{nodeId: '', portName: ''}`，让 validator 的 missing 规则在编辑期立刻可见）。
6. **inspector 表单 ↔ 字段实时同步**：`SourcePortField`（两下拉框）继续渲染、仍可手动选择；选项变化即写字段（已实现）。本 RFC **不动**这部分，因为字段是唯一真值，表单读字段就自然一致——拖拽写字段后，下次打开抽屉两下拉框自动显示新选择，无需额外同步代码。
7. **抽 `fanoutSourceSync` 纯函数模块**：在 `packages/frontend/src/components/canvas/fanoutSourceSync.ts` 新建文件，导出：
   - 常量 `MULTI_SOURCE_PORT_HANDLE_ID = '__multi_source_port__'`
   - `applySourcePortConnection(def, conn) → next def`（命中顶部 handle 写字段、其它情况返回原 def 引用）
   - `clearSourcePortOnNodeRemoved(def, removedNodeIds[]) → next def`（级联清理）
   - `isValidSourcePortConnection(def, conn) → boolean`（自环 / 源不存在 守护）
   - 所有函数 ref-equality 短路、纯参数纯返回，便于 vitest 单测。
8. **打开 workflow 不做 heal**：与 RFC-007 不同，本 RFC **不**需要"老 workflow 打开即修"——因为 `sourcePort` 字段与 `edges[]` 没有应该一致的不变式（顶部 handle 拖入产生的不是边）。老 workflow 的 `sourcePort` 设过就有、没设就无，行为与今天完全相同。
9. **回归测试落档**：design.md §测试策略 列出全部用例：纯函数单测（applySourcePortConnection 6 case + clearSourcePortOnNodeRemoved 3 case + isValidSourcePortConnection 4 case）+ JSDOM canvas 集成测（顶部 handle 拖入写字段、左侧 catch-all 不被误触、二次拖入替换、源节点删除清空）+ 源代码层兜底（节点上 `__multi_source_port__` 字面量、顶部 handle 渲染、handleConnect 引用 fanoutSourceSync）。

### 2.2 不做（明确划出去）

- 不把 sourcePort 升级为 `definition.edges[]` 的一种特殊边。理由：scheduler / validator / dep graph 三处都把 `sourcePort` 当独立字段读，把它强行塞进 edges 要改 backend；本 RFC 范围明确只动 frontend 编辑器。完全 edge 化是 v2 的事。
- 不对 fanout 节点的左侧 catch-all 做任何修改。普通入边走老路径；顶部 handle 是**额外**入口，不是替代。
- 不引入"拖拽时高亮可放置 target"等增强动画。xyflow 默认行为足够，本 RFC 不展开 UI 雕花。
- 不对 task 详情 read-only 画布做任何特殊处理——read-only 模式画布本来就拒绝任何 connect / change 事件，sourcePort handle 在视觉上存在即可（不能被拖到）。
- 不引入"source port 类型推断"——sharding 策略仍按 fanout 节点自己的 `sharding` 配置（per-file / per-N-files / per-directory）跑，本 RFC 不动。
- 不修改 i18n 默认 source/portName 占位符。

## 3. 用户故事

### 3.1 编排作者：拖一条线就指好 sourcePort

> 我建了一个 `git → designer → audit(agent-multi)` 工作流。我从 designer 节点的 `markdown_design` 输出 handle 拽一条线，落到 audit 节点**顶部**那个突出显示的 handle 上，期待 audit 节点上 sourcePort 立刻显示 `designer.markdown_design`，跟我去抽屉里两下拉框选完的效果一样。今天我必须先点 audit → 打开抽屉 → 找到 SourcePortField → 在源节点下拉里点 designer → 在端口下拉里点 markdown_design，**两次下拉 + 一次选项 = 三次操作**，明显比 RFC-003 落地后其它节点的"一拖了事"要繁琐。

### 3.2 编排作者：换源 = 重新拖一条

> audit 节点的 sourcePort 我之前指了 designer.markdown_design，现在我换成 auditorA.markdown_summary。我从 auditorA 的 markdown_summary 输出 handle 拽一条线落到 audit 顶部 handle 上，**期待旧的 designer → audit 拖入直接被替换**（视觉上顶部 handle 周围的"已连接"标记切换到 auditorA），不需要先删除旧关联。今天的下拉表单也是这种"重选即替换"逻辑，拖拽路径理应一致。

### 3.3 编排作者：拖到左侧不影响 sourcePort

> audit 节点的 prompt 模板里我写了 `{{ctx}}`，我从一个 contextProvider 节点的 output 拽一条线落到 audit 节点**左侧**普通输入区（catch-all）上，期待这条线只增加 `definition.edges[]` 一条普通入边 + 让 `{{ctx}}` 在运行时可解析，**不**改 sourcePort。两条入口语义彻底分离，不会因为我拖错位置一起改掉。

### 3.4 编排作者：删除上游节点自动清空 sourcePort

> 我误删了 designer 节点，audit 节点的 sourcePort 仍然指着 designer.markdown_design——这会让 validator 报 `agent-multi-source-port-missing references unknown node 'designer'`。期待画布在删除 designer 的瞬间就自动把 audit.sourcePort 清空，让我立刻在抽屉里看到"未选择"状态，主动去重新指。今天画布不会自动清，validator 错误在保存时才看见。

### 3.5 编排作者：自环不可拖

> audit 节点的输出我从右侧拽出来，胡乱往同一节点顶部 sourcePort handle 上拽，**期待拖不上去**（xyflow 视觉上拒绝），不能让一个 agent-multi 节点自己 fanout 自己。

## 4. 验收标准

每条都写成可在 CI 中跑绿 / 跑红的断言：

1. **顶部 handle 渲染**：vitest + JSDOM 渲染 `<AgentNode>` 的 fanout 形态（`data.kind === 'agent-multi'`）→ 断言 DOM 中存在 `Handle[id="__multi_source_port__"]` + `aria-label="multi-source-port"`、`position="top"`、`type="target"`；agent-single 形态不存在该 handle。
2. **顶部 handle 拖入写字段、不写边**：vitest + 渲染 WorkflowCanvas + `definition` 含 fanout 节点 + 上游 agent；调用 `onConnect({source: 'designer', sourceHandle: 'markdown_design', target: 'audit', targetHandle: '__multi_source_port__'})` → 断言（a）`definition.nodes[auditIdx].sourcePort = {nodeId: 'designer', portName: 'markdown_design'}`；（b）`definition.edges[]` 长度不变（无新边）。
3. **二次拖入替换**：从断言 2 状态调 `onConnect({source: 'auditorA', sourceHandle: 'markdown_summary', target: 'audit', targetHandle: '__multi_source_port__'})` → 断言 sourcePort 切到 `{nodeId: 'auditorA', portName: 'markdown_summary'}`；edges 长度仍不变。
4. **左侧 catch-all 不被误触**：同场景下调 `onConnect({source: 'ctx', sourceHandle: 'out', target: 'audit', targetHandle: '__inbound__'})` → 断言（a）`definition.edges[]` 多一条普通入边（RFC-003 既有行为）；（b）sourcePort 不动。
5. **自环拒绝**：`isValidSourcePortConnection(def, {source: 'audit', target: 'audit', targetHandle: '__multi_source_port__'})` 返回 false；JSDOM 集成调 `onConnect` 也不写字段（早退）。
6. **源节点删除级联清空**：定义含 audit.sourcePort = {nodeId: 'designer', portName: 'markdown_design'}；触发 `onNodesChange` 删除 designer → 断言 audit.sourcePort 被重置为 `{nodeId: '', portName: ''}`（或纯函数 `clearSourcePortOnNodeRemoved` 直接验）。
7. **inspector 表单同步**：从断言 2 状态打开抽屉 → `SourcePortField` 两下拉显示 `designer (agent-single)` + `markdown_design`（字段是真值，表单只读字段，无需额外断言代码，但写一条 JSDOM 集成验视觉同步）。
8. **scheduler / validator 零回归**：执行 `bun run --filter @aw/backend test` 既有 `tests/scheduler-*.test.ts` + `tests/workflow-validator.test.ts` 套件全绿——sourcePort 字段语义未变化、backend 路径未触碰。
9. **源代码层兜底**：新增 `packages/frontend/tests/canvas-fanout-source-port-not-floating.test.ts`：fs.read + 正则锁——`AgentNode.tsx` 在 fanout 分支渲染含 `__multi_source_port__` 字面量 + `position="top"` + `type="target"`；`fanoutSourceSync.ts` 文件存在且 export 4 个符号；`WorkflowCanvas.tsx` 引用 `./fanoutSourceSync` 且 `handleConnect` 体内调 `applySourcePortConnection`。文件顶部注释链回本 RFC + commit hash（TBD）。
10. **三件套全绿**：`bun run typecheck && bun run test && bun run format:check` 必须过；推 push 后按 [feedback_post_commit_ci_check] 查 GitHub Actions（含 build-binary + Playwright e2e）全绿。

## 5. 风险与回滚

- **风险 1：与 RFC-003 catch-all 误触**。catch-all 监听整个左侧 12px 透明带；顶部 handle 在 `Position.Top` 上，xyflow 自身按 handle id 路由 `targetHandle`。**对策**：`handleConnect` 入口判定 `conn.targetHandle === MULTI_SOURCE_PORT_HANDLE_ID` 走新路径、否则走老路径；两条互斥；验收 4 锁。
- **风险 2：xyflow `useUpdateNodeInternals` 没正确触发**。fanout 节点新加 handle，xyflow 用 ResizeObserver 自动检测；但若 `data.kind` 从 agent-single 切到 agent-multi（用户手动改字段），handle 出现需要重算。**对策**：`AgentNode` 用 `useUpdateNodeInternals(id)` + `useEffect` 监听 `data.kind` 变化触发——参考 RFC-003 catch-all 的相同处理。
- **风险 3：源节点删除级联未触发**。`WorkflowCanvas` 的 `onNodesChange` 路径上要在节点删除后把所有 fanout 节点的 sourcePort 一遍清扫。**对策**：抽 `clearSourcePortOnNodeRemoved` 纯函数；删除事件中收集被删 nodeId 后调用。验收 6 锁。
- **风险 4：替换语义引发"用户不知道旧的没了"的困惑**。**对策**：本 RFC 不弹 toast、不要求确认（与 RFC-005 review 决策三按钮的"显式确认"风格相反）——用户主动拖一条新线本来就是"要换"的明确表态，符合编辑器的直觉。i18n 文案在 inspector SourcePortField 上方加一行 muted 提示"也可以从顶部 handle 拖入设置"（key `inspector.sourcePortDragHint`，2 条中英）。
- **风险 5：scheduler dep graph 与边渲染分离**。scheduler 在 `:1320` 把 `sourcePort.nodeId → multi-node` 注入 DAG——这条依赖在 `definition.edges[]` 里完全不可见，xyflow 也不会画线把 designer 与 audit 连起来（视觉上"拖到顶部 handle"完成后画面上只有 handle 周围的"已连接"指示器，没有线）。**对策**：design.md §3.3 给出视觉契约：顶部 handle 在 sourcePort 有值时以填充态显示（`.canvas-node__handle--shard-source.is-connected` CSS class），让用户清楚"已连接"。**不**画 xyflow edge，避免和 edges[] 混淆。
- **风险 6：sourcePort 单输入语义在画布上不直观**。**对策**：在 fanout 节点 body 内现有的 "sourcePort: x.y" 文字下方加 i18n 提示"单一来源，拖入或表单选择都可"——已在 inspector 体现，画布节点保留现有最小信息密度。
- **回滚**：本 RFC 单 PR，纯 frontend 编辑器层。出问题 `git revert` 即恢复"sourcePort 只能在抽屉表单里选"现状；老 workflow / scheduler / DB 行 0 影响（字段从未被破坏，runtime 一直按字段取）。

## 6. 工业参考

- **Dify**（xyflow v12 同栈）：所有节点的"特殊语义入口"都通过命名 handle + 视觉差异（颜色 / 形状）暴露，避免与普通输入混淆。fanout-like "iterator" 节点用顶部专用 handle 接收待 sharding 集合，与本 RFC 选型一致。
- **Langflow**：sharding / map 节点同样用顶部独立 handle 表达"批处理来源"。
- **ComfyUI**：BatchSampler 节点用顶部 socket 接收 batch input、左侧 socket 接收普通参数；语义双轨清晰。
- **n8n**：SplitInBatches 节点的 `items` 输入是顶部专用 handle，左侧仅接 trigger；与本 RFC 同形。

## 7. 后续 RFC 衔接

- **RFC-（候选）edge 化 sourcePort**：把 `sourcePort` 字段彻底去掉，全部走 `definition.edges[]`，scheduler 与 validator 改从边反推。本 RFC 是其铺垫（顶部 handle 视觉模型与 edge 视觉模型隔离干净，未来若合并由"加 edge 写法 + 删字段"一步切换）。
- **RFC-（候选）多 sourcePort**：若产品需要 fanout 同时按多端口 sharding（cross-product / zip 等），本 RFC 的顶部单 handle 不阻塞，只需把 handle 数量改成 N + schema `sourcePort: PortRef` 升为 `sourcePorts: PortRef[]`。
