# 前端：工作流画布编辑器（xyflow） — 架构审计 (2026-06-23)

> 范围 key=14-frontend-canvas-editor。代码锚点：`packages/frontend/src/components/canvas/*`（含 `nodes/*`）、`routes/workflows.edit.tsx`、`lib/node-prompt.ts`、`fixtures/demo-workflow.ts`。
> 与既有审计的关系：dedup-audit-2026-06-13 已覆盖「canvas 纯逻辑可测预言」与 `is-wrapper-kind-predicate`（#4/#91，13 站）。本报告**不重复**这些条目，而是从**架构层 + 扩展性**角度延伸：WorkflowCanvas 是否 god-component、加新节点类型/新 wrapper 的真实成本、纯逻辑层抽象是否泄漏。证据均为 file:line（相对仓库根）。

---

## 0. 健康度一句话

纯逻辑层抽得相当好（18 个导出预言 + 78 个 canvas 测试文件，业内少见），但 **`WorkflowCanvas.tsx`(1828 行) 与 `NodeInspector.tsx`(1486 行) 已是双 god-component**，且「每加一个特殊节点类型就新开一个 `XxxDragHelper.ts` + 在 `handleConnect`/`isValidConnection` 各塞一段 + NodeInspector 加一个 switch case」的模式让节点类型扩展成本随类型数线性叠加——结构健康、扩展性中等偏下。

## 1. 当前架构与职责

`WorkflowCanvas`（`ReactFlowProvider` 外壳 + `CanvasInner` 实体）把 `WorkflowDefinition` ⇄ xyflow `Node[]/Edge[]` 双向往返：`toFlowNodes`/`toFlowEdges`/`computePorts` 投影下行，`toDefinition`/`commitChange` 收敛上行；坐标在 `coordProjection.ts` 做 absolute⇄relative（嵌套 wrapper 父子）转换；wrapper 成员判定/裁剪/适配在 `wrapperMembership/wrapperFit/wrapperOps/wrapperCandidates`；每种「特殊连线语义」各有一个纯 helper（`connectionSync`=review/output、`clarifyDragHelper`=RFC-023、`crossClarifyDragHelper`=RFC-056、`fanoutSourceSync`=RFC-015/060）。`NodeInspector` 是右抽屉，一个 `switch(node.kind)` 9 分支渲染每种节点的表单。自动保存/多 tab 同步在 `routes/workflows.edit.tsx`（1s debounce setTimeout + `useWorkflowSync`）。

关键文件：`WorkflowCanvas.tsx`(god-component)、`NodeInspector.tsx`(god-component)、`coordProjection.ts`、`connectionSync.ts`、`clarifyDragHelper.ts` + `crossClarifyDragHelper.ts`、`wrapperMembership.ts`/`wrapperFit.ts`、`nodePalette.ts`、`routes/workflows.edit.tsx`、`shared/node-kind-behavior.ts`(被无视的单一事实源)。

---

## 2. 设计问题（Design）

**[CANVAS-D1] 节点类型语义分散在 5+ 处，无「节点类型注册表」** — 级别 P1｜类型 design/extensibility｜证据 `WorkflowCanvas.tsx:100-112`(NODE_TYPES) + `nodePalette.ts:11-20,166-176`(PaletteItem/SHORT) + `nodePalette.ts:58-151`(makeNode) + `WorkflowCanvas.tsx:1203-1346`(computePorts switch) + `NodeInspector.tsx:172-1196`(EditForm switch 9 case)｜影响：一个节点类型的「身份」散落在 `NODE_TYPES`、`PaletteItem` 联合、`SHORT` 前缀表、`deserialize` 白名单、`makeNode` 默认值、`computePorts` 端口推导、`NodeInspector` 表单、`node-prompt.isPromptCapableKind`、`NodeInspector.hasPreview` 至少 9 个独立位置——没有一个集中的「NodeKindDescriptor」把它们绑在一起，加类型必须人肉巡检全部。｜建议：引入前端侧 `nodeKindRegistry`，每个 kind 一条记录 `{component, paletteSection, idPrefix, defaultNode, computePorts, InspectorForm, promptCapable}`，`NODE_TYPES`/`buildPalette`/`makeNode`/`computePorts`/`NodeInspector` 都从它派生。可与 `shared/node-kind-behavior.ts` 的 `satisfies Record<NodeKind,...>` 同款编译期穷举对齐。

**[CANVAS-D2] `shared/node-kind-behavior.ts` 是声明过的单一事实源，但 canvas 层完全没用** — 级别 P2｜类型 design/coupling｜证据 `shared/node-kind-behavior.ts:1-24`（注释明确「single source of truth for per-NodeKind cross-cutting behavior … 加新 NodeKind TypeScript 会编译失败」）；`grep node-kind-behavior packages/frontend/src/components/canvas/` = 空（canvas 一次都没 import）。｜影响：后端用 `satisfies Record<NodeKind>` 强制穷举来防「加 kind 漏改」，前端 canvas 却退回到散落 `kind === 'x'` 字面量——同一个「加 kind 必须照顾到」的契约在前端没有任何编译期护栏，前后端心智模型割裂。｜建议：把 wrapper 集合、prompt-capable、is-process 等谓词上提到 `node-kind-behavior.ts`（dedup-audit #4 已建议加 `isWrapperKind`），前端从同一张表派生，扩展性护栏前后端统一。

**[CANVAS-D3] design.md M2 承诺的「撤销重做 / 自动布局」未实现** — 级别 P2｜类型 design/test-gap｜证据 `design.md:1577`（M2 范围列「右键菜单 / **撤销重做** / 多选 / **自动布局**」）；`grep -rln "useUndoRedo|undoStack|takeSnapshot|redoStack|autoLayout|dagre|elk" packages/frontend/src` = 空。｜影响：编辑器无 undo——`commitChange` 每次直接覆盖 draft，误删 wrapper（连带内层节点，`deleteWrapperWithChildren`）或误连后只能手动恢复；自动保存 1s 后即落盘，错误操作很快不可逆。属功能缺口而非 bug，但 god-component 现状会让事后补 undo 极痛（见 CANVAS-X4）。｜建议：要么在 STATE.md 显式降级登记为「v1 不做」，要么趁早在 draft 层引入 history stack（draft 在 route 层是单一 state，是天然插入点）。

**[CANVAS-D4] `ValidationIssue` 类型在前端被重新定义，与 shared 漂移** — 级别 P3｜类型 design/coupling｜证据 `routes/workflows.edit.tsx:457-464` 本地 `interface ValidationIssue {code,message,severity?,pointer?}` vs `shared/src/schemas/workflow.ts:253` `WorkflowValidationIssue`。｜影响：后端校验响应 schema 变化时前端不会编译报错；`pointer`/`severity` 的可选性靠两边人肉保持一致。｜建议：前端直接 `import type { WorkflowValidationIssue }`，删本地副本。

---

## 3. 实现问题 / Bug（Impl）

**[CANVAS-I1] `EditorSidebar` 搜索框 + `NodeInspector`/`EdgeInspector` 多处用原生 `<input className="form-input">`，违反 Frontend-UI-consistency 强制原则** — 级别 P2｜类型 impl-bug/coupling｜证据 `EditorSidebar.tsx:41-47`(`<input type="search" className="form-input form-input--sm">`)、`NodeInspector.tsx:290-318`（output 端口三个原生 `<input className="form-input">`），共 15 处原生 input（`grep "className=\"form-input"` 命中 `EdgeInspector/PromptPreview/NodeInspector/EditorSidebar`）。｜影响：CLAUDE.md「Frontend UI consistency」明确「禁止直接落 `<input className="form-input">`，必须走 `<TextInput>`/`<Field>`」——这些是已声明的产品级回归，focus ring / a11y / 占位风格与其余页面不一致。｜建议：换成 `<TextInput>`；output 端口行可抽一个 `<PortBindRow>` 公共子组件（与 review/fanout 的 bind 行复用）。

**[CANVAS-I2] `affectsDefinition` 漏掉 xyflow 可能的 add/replace 之外结构变更，但语义上是「保守白名单」——可接受，记录为待核验** — 级别 P3｜类型 待核验｜证据 `WorkflowCanvas.tsx:1487-1503`（只认 add/remove/replace，position/select/dimensions 排除）。我尝试推翻：position 单独走 `onNodeDragStop`、select/dimensions 是纯 UI，排除有充分注释依据且有 `canvas-edge-changes.test.ts` 锁。结论：**不是 bug**，仅作为「白名单需随 xyflow 升级核验」的提醒留存。

**[CANVAS-I3]（对抗式自检 · 已推翻）嵌套 wrapper 坐标投影只减直接父绝对位置——疑似漏算祖父偏移** — 级别 N/A｜类型 待核验（已排除）｜证据 `coordProjection.ts:194-206` + 测试 `wrapper-coord-projection.test.ts:83-107`。我尝试推翻其正确性：`projectDefinitionForXyflow` 先把每个节点解析到**绝对锚点**（`absX/absY`，wrapper 自身从 `resolveWrappers` 拿绝对位），再减**直接父的绝对位**——因为父的绝对位已含其自身相对祖父的偏移，单层相减对任意深度都成立。测试 git-in-loop 用例（a1 abs(150,200) → 父 git1 abs(50,50) → rel(100,150)）正确。结论：**无 bug**，记录此次对抗验证以免后人误判。

---

## 4. 扩展性瓶颈（Extensibility chokepoints）—— 本节是重点

**[CANVAS-X1] 「加一个新特殊节点类型（如 RFC-014 iterate sibling / 未来 approval-gate / sub-workflow 节点）」要 fork 一份 DragHelper + 在 4 个集中点各插一段** — 级别 P1｜类型 extensibility｜
- **未来场景**：半年后要加「子工作流引用节点」或「外部 webhook 等待节点」——一种有自己连线语义（特定 source/target 端口、需要 pre-flight 校验）的节点。
- **根因**：现有「特殊节点」全是「新建一个 `xxxDragHelper.ts`（classify + apply + cascade + hasExisting）+ 在 `WorkflowCanvas.handleConnect` 加一个 `classifyXxx(...) !== null` 分支 + 在 `isValidConnection` 加一段镜像 pre-flight + 在 `commitChange` 加一个 `cascadeRemoveXxxChannel` + 在 `deleteSelected` 加一个 `clearXxxEdgesForRemovedNodes`」。clarify(RFC-023) 与 cross-clarify(RFC-056) 就是把这套**几乎逐字抄了第二遍**（`clarifyDragHelper.ts` 295 行 ⟷ `crossClarifyDragHelper.ts` 408 行，函数名一一对应）。
- **现在加功能要碰**：`WorkflowCanvas.tsx`(`handleConnect`24 处链式调用 @ `:421-511`、`isValidConnection` @ `:521-612`、`commitChange` cascade @ `:203-229`、`deleteSelected` @ `:668-705`) + 新建 helper 文件 + `nodePalette.ts`(PaletteItem/SHORT/makeNode/deserialize) + `NodeInspector` switch + `computePorts` switch。**单类型 ≈ 碰 6 个文件 + 抄一份 ~300 行 helper**。
- **目标形态**：定义 `ConnectionStrategy` 接口 `{classify(def,conn), buildEdges(def,hit), preflight(def,conn), cascadeOnDelete(def,deleted), clearOnNodeRemoved(def,ids)}`，每种特殊节点实现一个 strategy，`handleConnect`/`isValidConnection`/`commitChange` 各遍历一个 strategy 注册数组即可。clarify 与 cross-clarify 的「ask/ans 双边 + 单边 designer」差异参数化进一份 helper。

**[CANVAS-X2] `WorkflowCanvas.tsx` 是 1828 行 god-component，关键编排逻辑（如 `onNodeDragStop` ~100 行）困在 JSX 里不可单测** — 级别 P1｜类型 extensibility/test-gap｜
- **未来场景**：要改 wrapper 拖入/拖出 + 自动 fit 的判定规则（很常见的 UX 迭代）。
- **根因**：`onNodeDragStop` 的 100 行（成员判定 + 收集 wrapper rect + `resolveMembershipOnDragStop` + `applyMembershipPatch` + `fitWrapperToInner`）作为**内联箭头函数**写在 `<ReactFlow onNodeDragStop={...}>` 上（`WorkflowCanvas.tsx:1046-1145`），而非像 `resolveMembershipOnDragStop` 那样抽成纯函数——`grep resolveDragStop|computeDragStop` = 空。它是 canvas 里最大的一坨**未抽离的纯转换逻辑**。
- **现在加功能要碰**：直接改 1800 行文件内部、无法对这段写单测（只能起整个 ReactFlow 跑集成），与团队「首选可断言面」原则（CLAUDE.md Test-with-every-change）冲突。
- **目标形态**：抽 `computeDragStopDefinition(prevDef, flowNodes, draggedNodes, measured): WorkflowDefinition` 纯函数（输入 xyflow 快照、输出 next def），`onNodeDragStop` 只剩 `commitChange(computeDragStopDefinition(...))`。同款思路把 `handleNodesChange`/`handleEdgesChange` 里的「删除后清父选区」逻辑下沉。

**[CANVAS-X3] `is-wrapper-kind` 三元谓词散落 ~13 站（已被 dedup-audit #4 覆盖）——本报告补「这是扩展性而非纯整洁问题」的论证** — 级别 P2｜类型 extensibility｜证据 `coordProjection.ts:30-36` 有私有 `isWrapperKind` 却**不导出**，于是 `wrapperCandidates.ts:73`、`wrapperOps.ts:17/45`、`wrapperMembership.ts:85`、`WorkflowCanvas.tsx:1065/1092/1375/1627/1803`、`NodeInspector.tsx` 各自手写 `kind === 'wrapper-git' || 'wrapper-loop' || 'wrapper-fanout'`。｜**已被 dedup-audit-2026-06-13 §4.4 `is-wrapper-kind-predicate`(13 站, 落点 `shared/node-kind-behavior.ts`) 覆盖**。本报告补充其扩展性后果：RFC-060 加 `wrapper-fanout` 时，正是因为这个集合没收口，`coordProjection.ts:31-35` 留下「`wrapper-fanout` 漏进 isWrapperKind → 拖出的 fanout 渲染成只剩 header 的小块」这种 bug（注释自述）——下一个 wrapper 类型（如未来 `wrapper-parallel`）会重演。｜建议：同 dedup-audit，导出共享 `isWrapperKind`。

**[CANVAS-X4] 自动保存与 draft 是「单一 state 覆盖式」，无操作历史，未来加 undo/协同编辑/冲突合并都要重构 draft 层** — 级别 P2｜类型 extensibility｜
- **未来场景**：加 undo/redo（CANVAS-D3）、或多 tab 真正协同（现在只是「别人改了→toast→refetch」，后写胜出会丢改动）。
- **根因**：`routes/workflows.edit.tsx:187` `draft` 是单一 `WorkflowDefinition | null` state，`onChange` 直接 `setDraft(next)`（`:424-427`）；多 tab 同步 `useWorkflowSync` 收到远端更新只 refetch（`:282-286`），自动保存「后写胜出」（design.md:1446 明说）。没有 op-log、没有 base-version 三方合并。
- **现在加功能要碰**：undo 需要在 draft 外再叠一层历史；真协同需要把「整 def 覆盖」换成「op/patch 流」——两者都要改 `commitChange` 的契约（目前是 `(nextDef) => void`，丢掉了「这次改了什么」的信息）。
- **目标形态**：`commitChange` 改为携带语义意图（`{kind:'add-node'|'move'|'connect'|...; patch}`），draft 层维护 history + 可选 patch 流。即便 v1 不做协同，先让 commitChange 带 intent 也能低成本支撑 undo。

**[CANVAS-X5] `computePorts` 端口推导是 canvas/inspector/校验三方各算一遍的「端口推导」缝（hotspot memory 点名的两条缝之一）** — 级别 P2｜类型 extensibility/coupling｜证据 `WorkflowCanvas.computePorts`(`:1203-1346`) 内联 review 的 `reviewApprovedPortName(inputKind)` + fanout 的 `deriveWrapperFanoutOutputs`，且 NodeInspector 从 `'./WorkflowCanvas'` 反向 import `computePorts`（`NodeInspector.tsx:33`）。｜影响：「一个节点对外暴露哪些端口」的真理被 canvas 持有，inspector 跨组件 import 它、后端 validator 又自己算一份；加新端口语义（如 review 第三个 outlet）要同步多处。memory `project_hotspot_fortify_refactor` 已把「端口推导」列为「抽一次别 fork」的缝。｜建议：把 `computePorts` 提到 `shared`（或 canvas 专用的 `portInventory.ts`），canvas / inspector / validator 共用一份，按 X1 的 registry 思路让每个 kind 自带 `computePorts`。

**[CANVAS-X6] `WorkflowNewPage` 与 `WorkflowEditPage` 把「sidebar + canvas + edge/node inspector」三栏 JSX 抄了两份** — 级别 P3｜类型 extensibility｜证据 `routes/workflows.edit.tsx:142-169`(New) ⟷ `:416-452`(Edit)，inspector 选择/closeInspector/canvasRef 逻辑两份。｜影响：editor 布局/抽屉/选区改动要改两处，易漂移。｜建议：抽 `<WorkflowEditorLayout def onChange selection onSelect agents />` 共享组件，New/Edit 只管各自的保存策略。

---

## 5. 耦合 / 分层违规

**[CANVAS-C1] `NodeInspector` 反向 import canvas 的 `computePorts`，inspector 依赖 canvas 内部** — 级别 P2｜类型 coupling｜证据 `NodeInspector.tsx:33` `import { computePorts } from './WorkflowCanvas'`。｜影响：inspector 本应只依赖纯逻辑层，现在依赖 1800 行渲染组件的导出；`WorkflowCanvas.tsx` 因此被迫导出 18 个符号（含 `__test*`）。｜建议：随 X5 把 `computePorts` 搬到独立纯模块。

**[CANVAS-C2] 大量 `as unknown as Record<string, unknown>` 绕过 WorkflowNode 判别联合** — 级别 P2｜类型 coupling/impl-bug-risk｜证据 全 canvas 充斥 `(n as Record<string, unknown>).nodeIds` / `(node as unknown as Record<string, unknown>)`（`computePorts:1208`、`toFlowNodes:1376/1382/1418`、`wrapperMembership:88`、`wrapperOps:26/51` 等数十处）。｜影响：`WorkflowNode` 是判别联合却几乎处处当 `Record<string,unknown>` 读写，类型系统对「wrapper 一定有 nodeIds」「review 一定有 inputSource」零保护——加字段/改字段名编译器不报错，是 silent-drift 温床。｜建议：给每种 kind 定义具体 interface 并在 `WorkflowNode` 联合里收口，canvas 用 `node.kind === 'x'` 收窄后直接读字段，删 `Record` cast。

**[CANVAS-C3] 自动保存的 useEffect 关掉了 exhaustive-deps lint** — 级别 P3｜类型 coupling/observability｜证据 `routes/workflows.edit.tsx:268-273`（`eslint-disable-next-line react-hooks/exhaustive-deps`，deps 手写 `[dirty,name,description,draft]` 漏 `save`）。｜影响：`save` mutation 引用若变化 debounce 行为可能用到旧闭包；属可接受妥协但缺解释，未来重构 save 逻辑易踩。｜建议：把 save 包成 ref 或注释清楚为何安全。

---

## 6. 测试 / 可观测性缺口

**[CANVAS-T1] 纯预言覆盖优秀，但最大的内联编排（`onNodeDragStop` 100 行）无单测** — 级别 P1｜类型 test-gap｜证据 78 个 canvas 测试文件覆盖 `resolveMembershipOnDragStop`/`applyMembershipPatch`/`computePorts`/`buildEdgeFromConnection`/`markBoundary*` 等，但 `WorkflowCanvas.tsx:1046-1145` 的拖停整链（rect 收集 → 成员 patch → fit）没有对应纯函数可断言。｜影响：wrapper 拖入拖出 + fit 是最易回归的 UX，却恰好是唯一没抽出来的大块逻辑。｜建议：随 X2 抽 `computeDragStopDefinition` 后补 ≥6 case（拖入/拖出/换 wrapper/嵌套/sizeLocked/空 wrapper）。

**[CANVAS-T2] 多 tab 同步「后写胜出丢改动」无回归测试，可观测性弱** — 级别 P2｜类型 test-gap/observability｜证据 `useWorkflowSync` 远端 update 已被刻意静音 toast（`routes/workflows.edit.tsx:275-286` 注释：自动保存的 WS 回声会误报），只保留 delete toast。｜影响：「A、B 两 tab 同时编辑，A 的自动保存覆盖 B」这条 design.md:1446 明确接受的行为，没有任何测试锁定其边界，也没有 version 冲突的可观测信号（用户不知道自己被覆盖）。｜建议：至少加一条断言「远端 version > 本地 → 不静默吞掉用户未保存改动」的测试；可观测性上考虑保存前 If-Match version 校验。

**[CANVAS-T3] god-component 内联 handler 的「删除后清父选区」分支靠注释自证，无源码层文本断言兜底** — 级别 P3｜类型 test-gap｜证据 `handleNodesChange:359-366` / `handleEdgesChange:404-411` / `deleteSelected:701-704` 三处重复「删了被选中项 → onSelect(null)」逻辑，注释详尽但无 `affectsDefinition` 那种导出预言。｜建议：把三处合并成一个 `shouldClearParentSelection(sig, removedIds)` 纯函数并单测。

---

## 7. 目标形态（Target architecture）

1. **NodeKind 注册表（前端）**：`nodeKindRegistry: Record<NodeKind, NodeKindDescriptor>`，`satisfies` 编译期穷举（对齐 `shared/node-kind-behavior.ts` 风格）。每条含 `{component, paletteSection, idPrefix, makeDefault, computePorts, InspectorForm, promptCapable, connectionStrategy?}`。`NODE_TYPES`/`buildPalette`/`makeNode`/`deserialize`/`computePorts`/`NodeInspector` 全部从它派生——加 kind = 加一条记录 + TS 逼你填全。
2. **ConnectionStrategy 抽象**：把 clarify/cross-clarify/fanout/review-output 四套散落 helper 收口为统一接口的数组；`handleConnect`/`isValidConnection`/`commitChange` 遍历它而非 if-else 链。clarify 与 cross-clarify 参数化为一份。
3. **WorkflowCanvas 瘦身**：所有 def 转换（dragStop、change→def、删后清选区）抽成 `canvasReducers.ts` 纯函数；组件只剩 xyflow wiring + state。目标 < 600 行。
4. **共享 portInventory + isWrapperKind**：`computePorts` 与 wrapper 谓词上提，canvas/inspector/validator 单一来源（X5 + dedup #4）。
5. **draft 层带 intent**：`commitChange` 携带语义意图，为 undo/redo（CANVAS-D3）和未来协同（X4）留接口。
6. **UI 原语收口**：删尽 canvas 内原生 `<input className="form-input">`，统一走 `<TextInput>`/`<Field>`（CANVAS-I1）。

---

## 8. Top 风险与建议优先级

| 排序 | ID | 标题 | 级别 | 类型 | 建议动作 |
|---|---|---|---|---|---|
| 1 | CANVAS-X1 | 加新特殊节点要 fork ~300 行 helper + 碰 6 文件 | P1 | extensibility | ConnectionStrategy 抽象 + 注册表 |
| 2 | CANVAS-X2 / T1 | `onNodeDragStop` 100 行困 JSX、不可单测 | P1 | extensibility/test-gap | 抽 `computeDragStopDefinition` 纯函数 + 6 case |
| 3 | CANVAS-D1 | 节点类型身份散落 9+ 处、无注册表 | P1 | design | 引入 `nodeKindRegistry` satisfies 穷举 |
| 4 | CANVAS-I1 | 原生 input 违反 UI-consistency 强制原则 | P2 | impl-bug | 换 `<TextInput>` + 抽 PortBindRow |
| 5 | CANVAS-C2 | 处处 `as Record<string,unknown>` 绕过判别联合 | P2 | coupling | 给每 kind 定具体 interface |
| 6 | CANVAS-D2 | 前端无视 `node-kind-behavior` 单一事实源 | P2 | design | 谓词上提共享，前后端同护栏 |
| 7 | CANVAS-X5 / C1 | computePorts 三方各算、inspector 反向 import canvas | P2 | extensibility/coupling | 提到独立纯模块 |
| 8 | CANVAS-X4 | draft 单一覆盖式、无 undo/无协同接口 | P2 | extensibility | commitChange 带 intent + history |
| 9 | CANVAS-D3 | M2 承诺的 undo/auto-layout 未做 | P2 | design/test-gap | 实现或在 STATE.md 显式降级 |
| 10 | CANVAS-T2 | 多 tab 后写胜出丢改动无测试/无信号 | P2 | test-gap/observability | 加冲突断言 + If-Match |
| 11 | CANVAS-X3 | is-wrapper-kind 13 站（已被 dedup #4 覆盖）| P2 | extensibility | 导出共享 isWrapperKind |
| 12 | CANVAS-X6/D4/C3/T3 | New/Edit 抄两份、ValidationIssue 重定义、deps 关 lint 等 | P3 | 多 | 机械抽取/删副本 |

> 说明：CANVAS-I2 / I3 是对抗式自检中**主动推翻**的疑似 bug（白名单需随 xyflow 升级核验 / 嵌套坐标投影实为正确），保留以备后人勿误判。
