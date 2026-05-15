# RFC-007 Proposal — Canvas review / output 节点支持拖拽连线

> 状态：Draft（2026-05-16）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

`WorkflowCanvas` 当前对三类"普通节点"（agent-single / agent-multi / wrapper-loop）的入边走拖拽：用户从上游节点的 output handle 拽一条线到下游节点左侧的 catch-all（RFC-003）或具名 target handle，`handleConnect`（`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:239-247`）经 `translateInboundConnection` + `buildEdgeFromConnection` 写到 `definition.edges[]`。这条路径被 RFC-003 / RFC-004 / RFC-006 反复打磨，已是用户的肌肉记忆。

但是**两类节点游离在拖拽之外**：

1. **review 节点**（RFC-005 落地）—— `packages/frontend/src/components/canvas/nodes/ReviewNode.tsx:37` 仅渲染右侧 outputs，**左侧完全没有 target Handle**（无 catch-all、无具名）。`packages/shared/src/schemas/review.ts:44-50` 注释里写着"Catch-all edges in canvas (RFC-003) feed the input"，但 ReviewNode.tsx:7-8 实际把 catch-all 关掉了——schema 的设计意图与渲染层实现已经漂移。用户配置 review 的"评审目标"只能去右侧抽屉 NodeInspector 表单里手填 `inputSource.nodeId` + `inputSource.portName`（`packages/frontend/src/components/canvas/NodeInspector.tsx` review 分支 12 字段之一）。
2. **output 节点** —— `packages/frontend/src/components/canvas/nodes/OutputNode.tsx:21` 通过 `PortHandles side="left"` 渲染了具名 target Handles（每个 input port 一个 dot，`PortHandles.tsx:54` 写明 `type="target"`），**handle 实际可被边落上**。但 `WorkflowCanvas.handleConnect` 只追加到 `definition.edges[]`，**不会回写 `node.ports[i].bind = {nodeId, portName}`**。结果：用户拖完一条线视觉上有边，但右侧抽屉 NodeInspector 里对应 port 的 bind 仍为空——runtime 仍按 bind 取值，导致这条 port 实际没有数据流。视觉与语义两套字段互相不感知。

### 1.1 直接成本

- **用户反直觉**：与 agent / loop 节点的入边交互方式不同，新人会先尝试拖拽，拖拽失败（review）或拖拽"无效"（output bind 仍空），再去翻表单，挫败感累积。
- **设计文档与代码漂移**：review.ts:47-49 注释里写的"catch-all 边馈入 + 显式 inputSource 字段"两轨方案没被实现，只剩"显式表单一轨"。
- **output 节点的 50% 实现状态**：handle 已经在 DOM 里、xyflow 允许边落上、但落上去不写 bind，这种"边连得上但没生效"的隐性失败比明确报错更坏。

### 1.2 为什么是现在

- RFC-005 已 Done，review 节点稳定落地半个月，正适合补齐 UX 一致性。
- RFC-006 已经把 PortHandles 行内化，handle 视觉锚点已经迁到节点 body 内部边缘；本 RFC 在新布局上做 connect 行为补齐，不需要再动渲染层 CSS。
- 用户最近反馈了同一问题（"为什么 review/output 不能拖"），趁热打铁不让认知差异沉积成"项目就这样"的接受。

### 1.3 本 RFC 不动哪些地方

- **不动**节点种类、节点 schema 字段（`inputSource` / `ports[].bind` 仍是权威字段，仅添加来源同步）。
- **不动** runtime / scheduler / runner / DB schema —— scheduler 仍按 `inputSource`（review）与 `port.bind`（output）取值；本 RFC 只让前端编辑期把这两个字段保持与边一致。
- **不动**已有 workflow 的 `definition.edges[]` 不需迁移；老 workflow 没有"review 入边 / output 入边"的就一直没有，本 RFC 在编辑期发现缺失时做幂等补边（不改写字段，只补边），不触发不必要的脏写回。
- **不动** RFC-003 catch-all 行为、RFC-004 input 端口契约、RFC-006 行内布局。Review 用单一具名 target handle（不是 catch-all）；output 复用已有具名 handles。
- **不动**右侧抽屉表单字段（保留为"显式编辑入口"），仅让表单与边双向同步。
- **不引入**新节点种类、新 schema 字段、新 i18n key（除复用 inspector.\*）、新 DB 列。

## 2. 目标

### 2.1 做

1. **review 节点新增单输入具名 target Handle**（id 固定为 `__review_input__`），位于节点左侧，对应"评审目标"这唯一一个语义输入。Handle 渲染走 `PortHandles` 还是 ReviewNode.tsx 自行 inline 一个 `<Handle>`，由 design.md §3.2 给出抉择。
2. **canvas connect 时双向写入**：`handleConnect` 命中 review 节点的 `__review_input__` handle → 写 `definition.edges[]` + 写 `node.inputSource = {nodeId: src.nodeId, portName: src.portName}`，同时**先删除该 review 节点已有的入边**（review 单输入语义）。命中 output 节点的具名 target handle → 写 `definition.edges[]` + 写对应 `node.ports[i].bind = {nodeId, portName}`，并**先删除同 port 已有的入边**（每 port 单输入语义）。
3. **canvas disconnect / edge 删除时双向回退**：选中边按 Delete / 节点删除联级删边 / EdgeInspector 删边时，若被删的是 review 节点的入边 → 清空 `inputSource`；若是 output 节点某 port 的入边 → 清空对应 `port.bind`。
4. **表单 onChange 写回边**：NodeInspector 表单里手动改 `inputSource.nodeId/portName` 或 `port.bind.nodeId/portName` → 同步重建对应边（先删旧、再加新）。改动 source 节点 id 不存在 / source port 不存在 时不重建边（写字段但不写边），等用户修好再补。
5. **抽 `connectionSync` 纯函数**：在 `packages/frontend/src/components/canvas/connectionSync.ts` 新建模块，导出 `applyConnectionForReviewOutput(def, edge)` / `applyDisconnectForReviewOutput(def, edge)` / `syncEdgeFromFormField(def, target, prevBind?, nextBind?)` 三个纯函数。所有 connect / disconnect / 表单同步都走它，便于 vitest 单测。
6. **打开 workflow 时的幂等补边**：`workflows.edit.tsx` 已有 RFC-004 的 `healLoadedDefinition`；扩它扫 review / output 节点，若 `inputSource` / `port.bind` 有值但 `definition.edges[]` 没匹配项 → 追加边（不改字段）。这处理 RFC-007 之前创建的老 workflow，让它们"打开即修"。
7. **iterate 态拖拽锁**：review 节点进入 `reviewIteration > 0` 后，前端拒绝在该 review 节点的入边上拖拽换源（`isValidConnection` 钩子返回 false + 短 toast 提示）。表单层面：iterate 态下表单 inputSource 字段置只读 + 提示原因。这条由 RFC-005 §9 "iterate only allows target port changes" 衍生而来：换源等于换评审目标，会让既有 doc_versions 历史无意义。
8. **回归测试落档**：design.md §测试策略 列出全部用例（连接 / 断开 / 表单回填 / 老 workflow heal / iterate 锁 / catch-all 不影响），含纯函数单测 + JSDOM canvas 集成测 + 源代码层兜底文本断言（按 [feedback_post_commit_ci_check] 的 fallback 模式）。

### 2.2 不做（明确划出去）

- 不把"边"升级为唯一真值。`inputSource` / `port.bind` 仍是 scheduler 的取值字段，本 RFC 只做"编辑期双向同步"。完全去字段化是 v2+ 的事，影响 backend 合约太大，本 RFC 不开此战线。
- 不对 input 节点做对称改造。Input 节点是 source 不是 sink，没有 bind 这一类字段需要回写；它本就只渲染右侧 source handles。
- 不引入"多输入"语义。Review 仍是单 inputSource，output port 仍是单 bind。如果未来要做 "review 看一组文档"或"output port 多上游聚合"，另开 RFC。
- 不动 wrapper-git / wrapper-loop。这两类节点本身就是容器，入边语义由内部子节点决定，不属于"被拖入"的目标。
- 不重排 review 节点已有视觉布局（title / id / inputSource 文字仍在节点 body 显示）。仅新增左侧 handle 锚点，handle 自然顶在节点左边垂直居中位置或顶部第一行——具体由 design §3.2 选定。
- 不动 EdgeInspector（RFC-003 落地的边编辑面板）。边的 source / target 编辑、删除按钮一律复用现有控件；额外的 inputSource/bind 同步走 connectionSync helper 在 canvas 层完成。
- 不做"老 workflow 数据库迁移"。补边在编辑期发生、靠 RFC-003 的 1s auto-save 触发写回；任务运行时 / scheduler 不依赖边的存在（它读字段），所以即便用户始终不打开编辑器，老 workflow 也能继续跑。

## 3. 用户故事

### 3.1 编排作者：拖一条线就完事

> 我建了一个 `worker → review → output` 工作流。当我从 worker 节点的 `markdown_design` output 拖一条线落到 review 节点上时，期待边出现 + review 节点上面 "评审目标"那行立刻显示 `worker.markdown_design`，跟我刚才在表单里手填的效果一模一样。今天我必须先点 review 节点 → 打开右侧抽屉 → 在两个输入框里手敲 `worker` + `markdown_design`，多两步且容易拼错。

### 3.2 编排作者：拖一条线进 output 的具体 port

> 我在 output 节点上配了两个展示 port：`final_doc` 和 `audit_report`。我从 worker.markdown_design 拖一条线落到 output 的 `final_doc` handle 上，期待右侧抽屉里 `final_doc` 这一行的 bind 自动填上 `worker.markdown_design`。今天这条边能拖出来、视觉上"连上了"，但启动任务后 output panel 上 `final_doc` 卡片完全是空的——因为 bind 没写进去，runtime 没数据可取。

### 3.3 编排作者：表单改一笔，边跟着动

> 我之前给 output 的 `final_doc` 端口配了 `bind = worker.markdown_design`，画布上对应的边自然存在。现在我在抽屉里把 bind 改成 `auditor.summary`，期待画布上的边自动从 worker 改连到 auditor。今天表单字段改完，画布上的边还指着 worker——视觉与语义不一致，下次重新打开抽屉看到两套答案都对不上。

### 3.4 老 workflow 维护者：打开即修

> 三个月前我用 YAML 导入了一个工作流，里面有几个 review/output 节点的 inputSource/bind 配好了但画布上没显示边（彼时设计就这样）。今天我升级到 RFC-007 后打开这个 workflow，期待画布自动把这些边画上去（基于已有字段），不要让我手动重连。

### 3.5 review iterate 守护者：iterate 态下不允许偷换评审目标

> Review 节点进入 iterate（第二轮）后，我误操作把入边从 worker 改连到另一个节点 `summarizer`。RFC-005 §9 规定 iterate 只允许 target port 字段变化（用于换字符串值），不允许换上游节点——否则历史 doc_versions 失去意义。期待画布拒绝这次连接 + 弹一条 toast 解释原因。

## 4. 验收标准

每条都写成可在 CI 中跑绿 / 跑红的断言：

1. **review 拖拽双向写**：vitest + JSDOM 渲染 WorkflowCanvas + `definition` 含一个 review 节点 + 一个上游 agent 节点；模拟从 agent 的 `markdown_design` 输出 handle 拖到 review 节点的 `__review_input__` handle → 断言 (a) `definition.edges[]` 多了一条；(b) `definition.nodes[reviewIdx].inputSource = {nodeId: 'agent_n', portName: 'markdown_design'}`；(c) 节点 body 内 `<code>` 元素显示 `agent_n.markdown_design`。
2. **review 单输入替换**：同上场景下再次拖一条不同源到 review → 断言 (a) `definition.edges[]` 总数不变（旧边被删）；(b) `inputSource` 指向新源。
3. **output 拖拽双向写**：含 output 节点（2 ports）+ 上游 agent。从 agent 的 `audit_md` 拖到 output 的 `final_doc` handle → 断言对应 port 的 `bind = {nodeId: 'agent_n', portName: 'audit_md'}`，另一 port 的 bind 不动；边数 +1。
4. **断开回退字段**：从场景 1 状态选中那条边按 Delete → 断言 (a) 边被删；(b) `inputSource = {nodeId: '', portName: ''}`（或 schema 默认空值）。对 output 同样测：断开 `final_doc` 的入边 → `port.bind = {nodeId: '', portName: ''}`。
5. **表单 → 边同步**：直接修改 `definition.nodes[reviewIdx].inputSource.nodeId = 'auditor'` → 触发 NodeInspector 提交 → 断言 `definition.edges[]` 中那条 review 入边的 source 改为 `auditor`。
6. **节点级联删边**：删除上游 agent 节点 → 所有指向 review/output 的入边一并被删 + `inputSource` / `port.bind` 清空。复用现有 WorkflowCanvas 节点删除路径加 sync 钩子。
7. **iterate 态 connect 拒绝**：review 节点 `reviewIteration > 0`（mock state）→ 模拟拖到 `__review_input__` → 断言 connect 被拒（`isValidConnection` 返回 false 或 `handleConnect` 早退）；表单 inputSource 字段为只读（HTML `disabled` 属性）。
8. **老 workflow heal**：`healLoadedDefinition` 接受含 `inputSource={nodeId:'w', portName:'md'}` 但 `edges[]` 空的 fixture → 输出多一条 review 入边；同样对 output port.bind 测。已有边的情况不重复追加（幂等）。
9. **catch-all 不被新逻辑误中**：含 agent 节点 + catch-all（RFC-003）→ 拖到 catch-all → `translateInboundConnection` 仍按现状改写 targetHandle 为 sourceHandle，**不触发** review/output 的双向同步代码路径（review/output 节点上不挂 catch-all 的，因此该路径不可能误中）。
10. **源代码层兜底**：新增 `tests/canvas-review-output-drag-not-floating.test.ts`：fs.read + 正则锁住——`ReviewNode.tsx` 含 `__review_input__` 字符串；旧注释 `Catch-all inbound strip is intentionally off` 已被替换；`WorkflowCanvas.tsx` 的 connect handler 引用 `connectionSync` 模块；`connectionSync.ts` 文件存在。文件顶部注释链回本 RFC + commit hash。
11. **三件套全绿**：`bun run typecheck && bun run test && bun run format:check` 必须过；推 push 后按 [feedback_post_commit_ci_check] 查 GitHub Actions 状态（含 build-binary + playwright e2e）落地绿。

## 5. 风险与回滚

- **风险 1：scheduler 仍读字段而非边，可能漏写**。若 connectionSync 在某条路径上忘了写字段（只写了边），运行时该节点会拿到空 inputSource / bind → runtime 报错 / 输出空。**对策**：三处入口（handleConnect / 节点边删除 / 表单提交）都走同一 helper；vitest 锁三条入口都触发字段写。验收 1/3/5 即覆盖三条入口。
- **风险 2：双向同步死循环**。表单写边、边触发画布 onChange、onChange 回 commitChange 再 derive 表单，理论上可能反复触发。**对策**：connectionSync 函数纯参数纯返回，调用方根据 ref-equality 判定是否提交（RFC-004 healLoadedDefinition 同款手法）。design.md §6 给出具体伪代码。
- **风险 3：xyflow `useUpdateNodeInternals` 没正确触发**。review 新加一个 handle，xyflow 用 ResizeObserver 自动检测；但若节点 data 变化导致 handle 重渲染，需手动 `useUpdateNodeInternals(nodeId)`。**对策**：design.md §3.4 给出何时 call 的清单（一律在 ports / handle id 列表改变时）。
- **风险 4：iterate 态判定来源**。`reviewIteration` 是 `node_runs` 表的列，不在 `definition.nodes` 里。前端编辑期严格上不知道当前是不是 iterate 态——编辑器是工作流定义视图，不是 task 运行视图。**对策**：iterate 锁只在 task 详情画布（read-only）上生效；编辑器画布永远允许拖拽换源（不会影响已运行任务的 doc_versions，因为运行时拿的是任务启动那一刻的 workflow snapshot）。design.md §5 明确这条边界。
- **风险 5：YAML 导入冲突**。YAML 里的 review 节点可能没有 inputSource、output 没有 port.bind，但有边。本 RFC 不动 YAML 解析；导入后 healLoadedDefinition 反过来也要从边补字段（如果字段空、边存在 → 写字段）。该路径见 design §6.4 - 反向 heal。
- **回滚**：本 RFC 单 PR，纯 frontend 编辑器层。出问题 `git revert` 即恢复"字段独立、边独立"现状；老 workflow 数据完全不受影响（字段从未被破坏，运行时一直按字段取）。

## 6. 工业参考

- **Dify**（xyflow v12 同栈）：所有节点（包括 end node 与各种 io）一律走拖拽连线，所有 sink 节点都有可见 target handle；UI 上不存在"必须去表单填来源"的隐藏配置项。本 RFC 与之对齐。
- **Langflow**：同 xyflow 路径，sink 节点（output）拖拽连接 = 自动写 binding 字段。
- **ComfyUI**：每个 sink port 一个 socket，拖一条线 = 给该 socket 绑定上游；从未有"右侧表单填来源"的设计模式。
- **n8n**：sink 节点（如 webhook response）也只能拖拽连接，节点定义里没有 binding 字段——它们走"前一节点输出"的隐式约定。本 RFC 不引入这种隐式约定，仍保留显式 inputSource/bind 字段作为合约。

## 7. 后续 RFC 衔接（v1.x+）

- **RFC-008（候选）**：把 `inputSource` / `port.bind` 完全去字段化，scheduler 改从 `definition.edges[]` 反推取值字段——一统江湖。需评估对 RFC-005 doc_versions / runtime / YAML schema 的影响。本 RFC 是它的铺垫（强制编辑期"字段 ↔ 边"严格一致），让后续切换的真值面只剩"删字段读边"一步。
- **RFC-009（候选）**：multi-input review（一组上游文档同时评审）。本 RFC 设计的 `__review_input__` 单 handle 不阻塞将来扩成多 handle，只需把 schema `inputSource: PortRef` 升级为 `inputSources: PortRef[]` + handle 数量按字段长度渲染。
