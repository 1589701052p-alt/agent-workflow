# RFC-003 Proposal — Canvas 输入端口连边可达性

> 状态：Draft（2026-05-15）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)

## 1. 背景

在 workflow 编辑器画布上**当前完全没法把上游节点的输出连进下游 agent 节点**。

实测路径（dev server，工作流 `01KRN2AJT8JCPGX40QRGFVR700`）：

| 节点 | 类型 | 左侧 (target) handle | 右侧 (source) handle |
| --- | --- | --- | --- |
| `in_9wn7sg` requirement | input | — | `requirement` |
| `wrap_git_yny27b` | wrapper-git | — | `git_diff` |
| `agent_xmcqzf` coder | agent-single | **无** | **无** |
| `fan_62p1vr` coder | agent-multi | **无** | `errors`（自动加） |

所有 agent 节点左侧都没 handle —— 根本拉不出第一条入边。`agent_xmcqzf` 右侧也没 handle，是因为 `coder` agent frontmatter 没声明 `outputs:`（这条单独修，不在本 RFC 主线）。

### 1.1 为什么会这样

`computePorts`（`packages/frontend/src/components/canvas/WorkflowCanvas.tsx:503-543`）的语义是：

- **输出端口**：取自 `agent.outputs`（agent / agent-multi）/ 固定 `git_diff`（wrapper-git）/ `outputBindings[].name`（wrapper-loop）/ `inputKey`（input 节点）。
- **输入端口**：完全等同于 "已存在入边的 `target.portName`" —— **没有边时返回空数组**，PortHandles 因此不渲染任何左侧 handle。

第一条入边永远没地方落，典型鸡生蛋。`promptTemplate` 里 `{{port_name}}` 占位符也**没有**被解析进 input 列表。

### 1.2 设计文档原本怎么定的

`design/proposal.md` §3.5 / §4.2 / §4.3 + `design/design.md` §5 / §7.3 写得很清楚：

- 输出端口由 agent.md `outputs:` 静态声明（与现状一致）。
- **输入端口不预声明**，是 edge 的副产品：
  - "输入端口默认与同名输出对应（按章节拼接到 prompt）"（proposal §3.5）
  - "一个输入端口允许接多条上游边" + "同 port 多上游 = 顺序拼接为同一章节，分隔符 `\n\n---\n\n`"（proposal §4.2）
  - 节点 prompt 模板里 `{{port_name}}` 替换为该 input port 的拼接内容；**未被引用的 input port 自动作为 `## {port}` 章节追加到 user prompt 后面**（proposal §4.3 + design.md §7.3 `renderUserPrompt`）
  - 静态校验：模板里的 `{{x}}` 引用了**没有边落入**的 port → task 不能启动（proposal §4.3，已在 P-2-01 实现）
- YAML 示例 `in_1.out → worker_1.requirement`（design.md:510）—— 目标端口名 `requirement` 由用户在建边时显式指定，**不必跟源端口同名**。

也就是说**画布的连线交互应当先建边、由边自带 `target.portName`，左侧具名 handle 是边的可视结果**——而不是先有 handle 才能落边。当前实现把因果关系搞反了。

### 1.3 本 RFC 不动哪些地方

`output` 节点和 `wrapper-loop` 的 **输出**侧用的是声明式 `bindings`（`node.ports[].bind` / `node.outputBindings[].bind`，详见 `NodeInspector.tsx:136-207` 与 `workflow.validator.ts:306-347`）—— 不参与 edge 图，是另一类语义。本 RFC **不**改 bindings 模型，也不改 output 节点的 inspector UI。

`wrapper-git` 设计上没有 input port（proposal §5），不属于本 RFC。

## 2. 目标

**做**

- 画布给「真正以 edge 形式接收输入」的节点类型（`agent-single` / `agent-multi` / `wrapper-loop`）渲染一个 **catch-all target Handle**（覆盖左侧整条边的不可见 hit zone），**与已有具名 handle 共存**。
- 用户从源节点右侧某个具名 source handle 拖线松手到目标节点的 catch-all 区域时，框架立刻建一条边，**默认 `target.portName = source.portName`**（设计 §3.5 默认值）。落地后 `computePorts` 自然推出新的具名 input handle。
- 已经存在的具名 input handle 上落边走"扇入合并"路径（同 port 名拼接），与 RFC 之前行为一致。
- 提供一个轻量"重命名 target portName" 路径：**单击 edge → 右侧抽屉切换到 EdgeInspector** 显示 `source.nodeId / source.portName`（只读）+ `target.nodeId`（只读）+ `target.portName`（可编辑）。让 design.md:510 那种 `in.out → worker.requirement` 显式重命名场景不必去 YAML 里改。
- 在 `agent` 节点的 NodeInspector 中（PortRefList 那行下面）新增一段提示："prompt 模板里引用了 `{{X}}` 但 `X` 没有入边" —— 直接把 P-2-01 校验的子集前置到编辑期，方便 self-debug。**不替代** task 启动校验。

**不做（本 RFC 之外）**

- 不解析 `promptTemplate` 里的 `{{xxx}}` 自动建 input port —— 仍是「edge 是 input port 的唯一来源」。
- 不改 `output` 节点 / `wrapper-loop.outputBindings` 等 bindings 模型。
- 不引入 edge label / edge 右键菜单。重命名 target portName 走 EdgeInspector 已经够用。
- 不动 `wrapper-git` 输入语义（设计就是没 input port）。
- 不动 multi-process 节点的 `sourcePort` 配置 —— 那是 inspector 字段，跟 input port wiring 是两回事。
- 不重写 P-2-01 静态校验（已在 backend）。
- 不动后端 schema：`Edge` 类型本来就是 `{ source: {nodeId, portName}, target: {nodeId, portName} }`，无需改 DB。

## 3. 用户故事

- **U1（最常见：建第一条入边）**：用户拖了 `requirement` input 节点和引用 `coder` agent 的 agent-single 节点。从 `requirement` 右侧 `requirement` handle 拖线，松手在 `coder` 节点左侧任意位置。框架建边 `in.requirement → coder.requirement`，`coder` 左侧立刻冒出 `requirement` 具名 handle。
- **U2（不同源 port 名）**：用户从 `wrapper-git` 的 `git_diff` source 拖线落到 `coder` 左侧 catch-all。新边 `target.portName = git_diff`，`coder` 左侧追加 `git_diff` 具名 handle。两个不同 portName 共存。
- **U3（同名扇入合并）**：用户希望第二条上游也接到 `coder.requirement`。从第二条上游右侧 `requirement` handle 拖线，**精确落到 `coder` 左侧已经存在的 `requirement` 具名 handle**。框架按现有逻辑建第二条同名边，运行时按 `\n\n---\n\n` 拼接（proposal §4.2 / design.md §7.3）。
- **U4（重命名目标 port）**：用户希望边 `in.out → worker.requirement` —— source 名是 `out`，但希望写进 worker 的 `{{requirement}}`。U1 路径默认建出的边是 `target.portName=out`。用户**点选这条边**，右侧抽屉切到 EdgeInspector，把 `target.portName` 改为 `requirement` 保存。`worker` 左侧的 `out` handle 消失、`requirement` handle 出现，没有数据丢失（同一条 edge 只是改名）。
- **U5（不可拖入的节点不渲染 catch-all）**：`wrapper-git`（设计上没 input port）/ `input`（只有 source）/ `output`（用 bindings）/ 其他无 input 语义节点的左侧不显示 catch-all，避免误导。
- **U6（防误连）**：拖线源节点是 `coder` 自身的某 source handle，拖到自身的 catch-all → 自环被 `buildEdgeFromConnection` 拒（已实现）。重复 (source.nodeId, source.portName, target.nodeId, target.portName) 也被拒（已实现）。
- **U7（编辑期自查）**：用户在 NodeInspector 写 prompt 模板 `Implement {{requirement}}`，但还没拉边。PortRefList 下方提示 `requirement` 没有入边；连一条进来后提示消失。

## 4. 验收标准

详见 [design.md §6 测试策略](./design.md#6-测试策略) 与 [plan.md](./plan.md)。核心断言：

1. 在画布上拖一个全新的 agent-single 节点（agent 没有声明 `outputs:`），其左侧渲染**1 个 catch-all target handle**（隐形 hit zone）；右侧 0 个具名 handle。
2. 从 input / wrapper-git / agent 的 source handle 拖线松手在 agent 节点左侧 catch-all 区域 → onConnect 触发 → 新边写入 definition，`target.portName === source.portName`。
3. 上一步建边后，agent 节点左侧出现一个具名 target handle，名字与 `target.portName` 一致。
4. 同一目标节点上同源不同 portName 拖入 → 多个具名 handle 并存。
5. 同名拖入到具名 handle → 直接建第二条同名边，不弹任何 UI（与 RFC 前行为一致）。
6. 单击一条 edge → 右侧 inspector 切到 EdgeInspector，显示 `source.nodeId / source.portName`（只读）+ `target.nodeId`（只读）+ `target.portName`（可编辑），保存后 definition.edges 中对应行更新。
7. EdgeInspector 改名后：(a) 同 source 同 target.portName 的重复边检测仍生效（保存时若与已存在边碰撞 → 拒绝改名 + 红字提示）；(b) 改名导致原 portName 没有任何边时该具名 handle 自动消失。
8. `wrapper-git` / `input` / `output` 节点左侧**不渲染 catch-all**（拖线松手不会建边）。
9. agent NodeInspector 在 PortRefList 下方新增一行 "缺失入边的引用 port"，列出模板里 `{{x}}` 但当前没有任何 edge target.portName=`x` 的端口名；为空时该行不渲染。
10. `bun run typecheck` / `bun test` 全绿；现有 canvas / inspector 单测不退化。

## 5. 非破坏性

- `WorkflowDefinition` schema 不变。新建的边形态与老工作流的边完全相同。
- `output` 节点 bindings 模型不动。
- 启动表单 / runner / scheduler / 后端校验全不动。
- 现有 PortHandles 渲染逻辑兼容：catch-all 是新增的额外 `<Handle>`，与具名 handle 并列；具名 handle 优先命中（z-index 高一层）。
- `agents.detail` / `workflow.detail` 等老路由不引入新 prop。

## 6. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| catch-all handle 与具名 handle 重叠 → 用户拖线时落点歧义 | catch-all 占据节点左侧一整条 12px 宽的隐形 strip；具名 handle 的小圆点在 z-index 上高一层，命中区只覆盖小圆点本身。设计 §3.2 详述命中策略与回归测试 |
| 拖线落空（落在节点边缘外） → 没建边但也没提示 | 沿用 xyflow 默认行为：连接失败无声；本 RFC 不引入 toast |
| 同 source 同 target portName 重复 → 已存在重复检测能否触发 | `buildEdgeFromConnection` 已检测重复 (source.nodeId+portName, target.nodeId+portName) 全等。复用，不另写 |
| EdgeInspector 改 target.portName 成"已存在的 portName" | 按 U4：合并到同名 port 是合法行为（扇入），但同 source 同 target portName 的重复边非法 → 改名前先检测，冲突则拒绝（红字提示），让用户先删另一条 |
| EdgeInspector 与 NodeInspector 状态切换 | onSelect 现在传 `nodeId | null`；扩展为 `{ kind: 'node', id } | { kind: 'edge', id } | null`，shadow 在编辑器路由层处理；底层 `WorkflowCanvas` 仅多发 onEdgeClick |
| catch-all 在快照测试 / a11y tree 里多出 noise | catch-all `<Handle>` 不带 label，aria-hidden 隐藏；仅多一个 hidden 节点，调整 PortHandles 单测快照即可 |
| 拖线时 xyflow 的 `isValidConnection` 默认接受所有连接 | 不引入额外校验；`buildEdgeFromConnection` 在 onConnect 内拒绝非法即可（同 RFC 之前行为）|

## 7. 参考

- 现有 canvas 实现：`packages/frontend/src/components/canvas/WorkflowCanvas.tsx`
- 现有 PortHandles：`packages/frontend/src/components/canvas/nodes/PortHandles.tsx`
- 节点渲染：`AgentNode.tsx` / `OutputNode.tsx` / `InputNode.tsx` / `WrapperNodes.tsx`
- NodeInspector：`packages/frontend/src/components/canvas/NodeInspector.tsx`
- 静态校验（已实现）：`packages/backend/src/services/workflow.validator.ts`（P-2-01）
- 设计依据：
  - `design/proposal.md` §3.5 / §4.2 / §4.3
  - `design/design.md` §5（Edge schema）/ §7.3（renderUserPrompt）
- 输出节点 bindings 实现（**本 RFC 不动**）：
  - `NodeInspector.tsx:136-207` / `workflow.validator.ts:306-326`
