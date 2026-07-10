# RFC-166 Agent 能力层——声明式输入端口 + 能力卡 + 编排者接入

> 状态：Draft
> 引出：用户 2026-07-10 在 RFC-164 工作组落地后提出动态 workflow 模式时点破——
> 「内置 agent 要具备理解现有 agent 能力……包括现在的 leader 模式，我想了下也需要
> 能先读各 agent 的能力，否则怎么实现聊天室呢？」
> 经两路调研（workflow 生成/校验 · agent 元数据）+ 两轮反问对齐后落档。
> 本 RFC 是 RFC-167「动态 workflow 空间」的**前置依赖**（能力层先单独落，两模式共用）。

## 背景

平台里有多个「编排者」需要**理解其他 agent 的真实能力**才能正确调度它们：

1. **RFC-164 工作组 leader**：leader 逐轮给成员派活，但当前 leader 花名册
   （`renderRosterBlock`，services/workgroupContext.ts）只注入 `@displayName` + 类型 +
   **roleDesc**（用户建组时手填的一句组内职责）。leader **看不到** agent 自身声明的能力
   ——`description`（用途）、`outputs`（产出哪些端口）、`bodyMd`（system prompt）。所以现在
   leader 派活是「半盲」的：按人填的一句角色描述选人，而非 agent 真实能干什么。
2. **RFC-167 内置编排 agent**（后续）：要根据 agent 池自动编排出 workflow，必须先读懂
   每个 agent「产出什么、需要什么输入、用途是什么」。

调研（design/RFC-166 附研究）揭示一个结构性缺口：**agent 只声明 `outputs`（带类型
string/markdown/signal/path/list，kindParser.ts:175-179），不声明 `inputs`**——输入契约是
隐式的，由 `promptTemplate` 里的 `{{token}}` 与入边 `target.portName` 匹配（validator 明说
"agent nodes accept any port name"，workflow.validator.ts:340-342）。因此编排者能确定性知道
每个 agent「产出什么」，但「需要什么输入」只能靠 description + system prompt 语义推断。

本 RFC 补齐这个缺口 + 建立统一的「能力卡」注入层，让 leader（补强）和内置编排 agent（新建）
共用一套「把 agent 真实能力结构化喂给编排者」的基建。

## 目标

1. **agent 声明式输入端口**（决策：可选、缺省空、prompt token 继续兼容）：
   `agents` 增 `inputs` 字段——与 `outputs` 对称的 `{name, kind, required?, description?}[]`。
   - **可选**：存量 agent 不声明 = 空数组，行为**字节不变**（运行时仍靠 `promptTemplate`
     的 `{{token}}` 隐式接入，validator 的 prompt-template 规则不动）。
   - 声明了 `inputs` 的 agent 才参与「确定性输入侧连线校验」（编排 / 未来 validator 增强）。
   - `kind` 复用既有端口类型体系（`string`/`markdown`/`signal`/`path<ext>`/`list<T>`，
     kindParser.ts）。
2. **能力卡（capability card）**——统一的 agent 能力结构化投影（决策：完整卡）：
   一个纯函数把 agent 渲染成能力卡，含 `description` + `inputs`（带 kind）+ `outputs`（带 kind）
   + `role`（normal/aggregator）+ **system prompt 摘要**（bodyMd 截断/摘要）。作为 leader
   花名册和编排 agent 的共享注入原语。
3. **leader 花名册接入能力卡**（补强 RFC-164）：把工作组 leader/成员花名册从「roleDesc-only」
   升级为「roleDesc + 能力卡」——leader 派活时看到成员 agent 的真实能力（description/inputs/
   outputs/prompt 摘要），派活更准。roleDesc（组内职责，用户手填）保留作为「本组内的角色定位」
   叠加在能力卡之上。
4. **编辑器 UI**：agent 编辑页支持声明 inputs 端口（与 outputs 编辑对称，复用既有端口编辑
   组件）；能力卡在需要处（工作组建组的成员选择、RFC-167 空间选 agent）可预览。

## 非目标

- **不强制存量 agent 声明 inputs**：inputs 恒可选，无批量迁移，无 breaking change。
- **不改 workflow validator 的现有 prompt-template 规则**：`{{token}}` 隐式接入继续有效；
  声明式 inputs 是**叠加**的确定性信息，不取代隐式路径（validator 的 inputs-vs-edge 强校验
  作为**可选增强**留 RFC-167 或后续，v1 只落 schema + 能力卡）。
- **不改 workflow 节点的 edge 模型**：edge 仍是 `{source:PortRef, target:PortRef}`；声明式
  inputs 只是让「target.portName 对应一个声明的输入端口」这件事从隐式变显式，不改连线机制。
- **不做能力自动探测**（从 bodyMd 推断 inputs/outputs）：能力卡是对**已声明**字段的投影。

## 用户故事

1. 我编辑 `code-fixer` agent，在「输出端口」旁边新增一个「输入端口」区，声明它需要
   `audit_report`（kind: markdown）作为输入 + 一句描述。保存后这个 agent 的能力卡就带上了
   输入契约。
2. 我在工作组里让 `planner` 当 leader，给它派活时——现在 leader 的花名册里每个成员 agent
   都带能力卡（「coder-a：实现后端逻辑；输入 spec(markdown)；输出 diff(markdown)、
   summary(string)；`aggregator`」），leader 据此更准地决定「把审计报告派给谁、谁的产出接谁」，
   而不是只看我手填的一句 roleDesc。
3.（RFC-167 预演）我建动态 workflow 空间选 agent 时，每个候选 agent 显示能力卡,我一眼看清
   它能干什么、接什么、产出什么。

## 验收标准

- AC-1 schema：`agents.inputs` 可选声明（`{name,kind,required?,description?}[]`），存量 agent
  = 空、行为字节不变；zod 正反例（合法端口/重名/非法 kind）。
- AC-2 能力卡纯函数：`renderAgentCapabilityCard(agent, opts)` 输出含 description/inputs/outputs
  （带 kind）/role/prompt 摘要；prompt 摘要按字符预算截断；空 inputs/outputs 优雅呈现。
- AC-3 leader 接入：工作组 leader/成员花名册注入能力卡（roleDesc 叠加保留）；纯函数断言
  花名册块含成员 agent 的 description/outputs；**prompt 隔离不变式**沿 RFC-099——能力卡只含
  agent 自身声明字段，绝不含 user_id（human 成员无能力卡，仍走 displayName）。
- AC-4 编辑器：agent 编辑页可增删输入端口（复用 outputs 端口编辑 UI 对称形态）；能力卡预览
  组件可复用。
- AC-5 迁移：`agents.inputs` 加列迁移（可空/默认 `[]`）；journal +1，upgrade-rolling 计数锁 bump，
  agents 全字段锁 +1。
- AC-6 门禁：typecheck + lint(0) + test + format + binary smoke + 前端 vitest；Codex 设计门 +
  实现门；新增 UI 复用公共组件。
- AC-7 零回归：workflow validator / 现有 agent CRUD / 工作组现有行为（roleDesc 仍在）全绿；
  声明式 inputs 是纯叠加。

## 决策记录（2026-07-10）

| # | 问题 | 拍板 |
| --- | --- | --- |
| 1 | RFC 结构 | 能力层先单独落，两模式共用（本 RFC = 能力层，RFC-167 = 动态 workflow） |
| 2 | 输入 gap 处理 | 给 agent 增补声明式输入端口 |
| 3 | 能力卡粒度 | 完整卡（description + inputs/outputs 带 kind + role + system prompt 摘要） |
| 4 | 存量迁移 | inputs 可选、缺省空、prompt token 继续兼容 |
| 5 | RFC 拆分 | 能力层 + 动态 workflow 两个 RFC（本 RFC 含 leader 花名册接入能力卡） |
