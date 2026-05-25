# RFC-063 — Clarify Node Single-Agent Attachment

状态：Done（2026-05-25 单 PR T1-T3 全部落地，待 commit + push CI 验证）

## 背景

平台目前有两类"反问"叶子节点：

- **RFC-023 `clarify`**（自反问）—— 1 input (`questions`) + 1 output (`answers`)；通过画布反向拖动把
  agent 的 `__clarify__` / `__clarify_response__` 系统端口与 clarify 节点的 `questions` / `answers`
  一次性接上 2 条边，形成 "agent ↔ clarify" 的反问闭环。
- **RFC-056 `clarify-cross-agent`**（跨代理反问）—— 1 input (`questions`) + 2 outputs
  (`to_designer` manual / `to_questioner` auto)；反向拖到 questioner agent 自动建 2 条边（与 RFC-023
  同结构），用户再手动从 `to_designer` 拖到 designer agent 建第 3 条边，questioner / designer 各 1 个。

产品语义上，每个"反问节点"对应**单一 agent 角色**：

| 节点类型              | 期望角色绑定                                                  |
| --------------------- | ------------------------------------------------------------- |
| `clarify`             | 恰好 1 个 agent（既问也答）                                   |
| `clarify-cross-agent` | 恰好 1 个 questioner + 恰好 1 个 designer（角色分离，各 1 个） |

但当前 `services/workflow.validator.ts` 只对**反向关系**做了守门（"同一个 agent 不能挂 ≥2 个 clarify
节点" → `clarify-multiple-clarify-on-same-agent`），对**正向关系**没有任何拦截：

- `clarify` 节点的 `questions` 端口允许有 N (>1) 条入边，来源 agent 各不相同（validator 收 `agentSourceIds: Set`
  但只用来跑反向规则，不报错）。
- `clarify-cross-agent` 节点的 `questions` 端口同样允许多 questioner；`to_designer` 端口允许多 designer 目标
  （现有代码 `questionerId` 在 loop 里被覆盖、`toDesignerOut` 数组未对 target node 去重计数）。

这种放任带来的实际后果：

- **Submit 路径分裂**：cross-clarify submit 时 runtime 假设只有 1 个 designer 关系列（`cross_clarify_sessions.target_designer_node_id`
  存 1 行），但画布允许 2+ designer 目标 → submit 仅按 manual edge 的拓扑解析时取 first / 任意一个、其他被静默丢弃，
  与用户看到的"我连了两个 designer 都应该收到反馈"完全不符。
- **Self-clarify Q&A 路由歧义**：1 个 clarify 节点收两个 agent 的 `<workflow-clarify>` envelope 时，session
  关系列只挂到 1 个 agent，另一边的"提问"在用户提交后无人接收。
- **拓扑无意义**：1 个 cross-clarify 节点的 questioner / designer 角色都是单数的设计假设；让画布允许多
  questioner 等于把"反问环"画成"反问网"，没有任何 runtime 路径能正确解释这种图。

## 目标 (Goals)

1. **画布层硬约束 1:1 角色绑定**（schema-time / write-time / `POST /api/workflows/:id/validate`）：
   - **G1（self-clarify）**：`clarify` 节点的 `questions` 端口入边 source 中**去重后 unique agent 数 ≤ 1**。
   - **G2（cross-clarify questioner）**：`clarify-cross-agent` 节点的 `questions` 端口入边 source 中**去重后
     unique agent 数 ≤ 1**。
   - **G3（cross-clarify designer）**：`clarify-cross-agent` 节点的 `to_designer` 端口出边 target
     **去重后 unique agent 数 ≤ 1**。
2. **错误码可定位**：3 条新规则各自一个稳定 kebab-case `code`，message 含节点 id + 冲突的 agent id 列表，方便
   editor 跳转。
3. **零现有合法图回归**：1 questioner + 1 designer + 1 cross-clarify 的 RFC-056 happy path 字节级守恒；
   "多个 cross-clarify 指向同一个 designer"（RFC-056 §6 多源等待 banner 模式）保持合法不报错。

## 非目标 (Non-Goals)

- **不动 runtime**：runner / scheduler / cross_clarify_sessions 关系列存储一行不动。runtime 仍按
  "1 designer / 1 questioner per cross-clarify session" 假设；validator 把这条假设抬升为强约束。
- **不引入 canvas drag-prevention**：复用既有 schema-time 校验，前端只在 `validate` 调用时把 issue 渲染到
  inspector / banner（与所有其它 validator 规则一致）。canvas 端"拖动时直接禁止"作为可选 follow-up，本 RFC
  不涉及。
- **不动 RFC-023 反向规则**（`clarify-multiple-clarify-on-same-agent`）：那条是"同一个 agent 被多个 clarify
  挂"的镜像约束，与本 RFC 的"同一个 clarify 挂多个 agent"互补，两条并存。
- **不动 i18n / 文案**（除新 issue code 的英文 message）：validator 报文仅在英文 message + frontend 既有
  validation-issue 渲染走默认 fallback。
- **不引入新 schema / migration / drizzle 改动**：纯 validator 逻辑。

## 用户故事

**US-1**：用户在 canvas 上对一个已经接好 questioner-A 的 `clarify-cross-agent` 节点又反向拖到 questioner-B —
保存 / validate 时弹出 inspector banner 标红 "cross-clarify-multiple-questioners: clarify-cross-agent node
'ccx' has inbound 'questions' edges from multiple agents (qA, qB); only one questioner agent allowed per
cross-clarify node"，提示用户先删掉一条入边。

**US-2**：用户手动从一个 `clarify-cross-agent` 节点的 `to_designer` 拖到 designer-A，又拖到 designer-B —
validate 时报 `cross-clarify-multiple-designers`，messaging 列出冲突 designer id。

**US-3**：用户给一个 `clarify` 节点同时反向拖了 2 个不同 agent — validate 时报
`clarify-multiple-source-agents`。

**US-4（不报）**：1 个 cross-clarify 节点的 `questions` 端口有 2 条入边但都来自**同一个** agent-single
（边 id 不同、port name 都是 `__clarify__`，比如手动复制粘贴产生的重复 edge）—— `agentSourceIds`
去重后 = 1，本 RFC 不报；现有 edge-duplicate 规则若存在则照常报。

**US-5（不报）**：2 个 cross-clarify 节点 ccx1 / ccx2 各自 to_designer 都指向同一个 designer-A
（RFC-056 §6 多源等待 banner 模式）—— 每个 ccx 自己的 to_designer 出边 target 数 = 1，本 RFC 全部不报。

## 验收标准 (Acceptance Criteria)

**Validator 行为矩阵**：

| 场景                                                                                                              | 期望 issue code                          | severity |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | -------- |
| `clarify` 节点 `questions` 端口收 2 个不同 agent 的 `__clarify__` 出边                                            | `clarify-multiple-source-agents`         | error    |
| `clarify-cross-agent` 节点 `questions` 端口收 2 个不同 agent 的 `__clarify__` 出边                                | `cross-clarify-multiple-questioners`     | error    |
| `clarify-cross-agent` 节点 `to_designer` 出边 target 含 2 个不同 agent-single 节点                                | `cross-clarify-multiple-designers`       | error    |
| `clarify-cross-agent` 节点 `questions` 端口收同一个 agent 的 2 条 `__clarify__` 入边（重复边）                    | 无（dedup 后 1 agent）                   | —        |
| `clarify-cross-agent` 节点 `to_designer` 出边到同一个 designer 节点 2 次（重复边）                                | 无（dedup 后 1 designer）                | —        |
| 1 designer + 1 questioner + 1 cross-clarify（RFC-056 happy path）                                                  | 无新增 error                             | —        |
| 2 cross-clarify 各 1 designer 都指向 designer-A（多源等待 banner 模式）                                            | 无新增 error                             | —        |
| 1 agent + 2 clarify 节点（已有反向规则）                                                                          | `clarify-multiple-clarify-on-same-agent` | error    |

**测试用例**（≥ 8 新 case）：

- AC-1 self-clarify 同一 agent 2 条入边（重复）→ 不报 `clarify-multiple-source-agents`
- AC-2 self-clarify 不同 agent 2 条入边 → 报 `clarify-multiple-source-agents`，message 含两 agent id
- AC-3 cross-clarify questioner 同一 agent 2 条入边 → 不报 `cross-clarify-multiple-questioners`
- AC-4 cross-clarify questioner 2 个不同 agent 入边 → 报 `cross-clarify-multiple-questioners`，message 含两 agent id
- AC-5 cross-clarify designer 同一 designer 2 条 to_designer 边 → 不报 `cross-clarify-multiple-designers`
- AC-6 cross-clarify designer 2 个不同 designer 出边 → 报 `cross-clarify-multiple-designers`，message 含两 designer id
- AC-7 RFC-056 happy path（1q + 1d + 1cc）→ 不报本 RFC 任何新 error
- AC-8 多源等待 banner 模式（2 cross-clarify → 同一 designer）→ 不报本 RFC 任何新 error；既有 RFC-056 测试不退化

**回归保险**：

- RFC-023 套件 `workflow-validator-clarify.test.ts`（6 case）零退化
- RFC-056 套件 `workflow-validator-cross-clarify-rfc056.test.ts`（已有的 happy / target-not-agent /
  has-downstream / manual-edge-missing / target-not-ancestor / auto-edge-deleted / self-review-warning）
  全绿
- `cross-clarify-validator-rules.test.ts` 7 rules enum 守门继续锁住编码命名（新规则加入 enum）

## 与既有 RFC 的关系

- **RFC-023（self-clarify）**：本 RFC 在 §4c 段落增加一条正向 multiplicity 规则；反向规则
  `clarify-multiple-clarify-on-same-agent` 一行不动。
- **RFC-056（cross-clarify）**：本 RFC 在 §4d 段落增加 2 条正向 multiplicity 规则；现有 7 条规则一行不动。
  RFC-056 §6 描述的"多源等待 banner"模式（多 cross-clarify → 单 designer）是 N:1 关系，本 RFC 锁的是
  cross-clarify 节点自身 to_designer 的 1:N（禁止），方向相反，不冲突。
- **RFC-058 / RFC-059**：本 RFC 不动 clarify_rounds / question scope；新规则只看 workflow.definition.edges
  的拓扑形状，与 runtime / DB 完全解耦。
- **RFC-060（fanout）**：本 RFC 不处理 wrapper-fanout 内部的 cross-clarify 行为（RFC-060 已说明 cross-clarify
  inside fanout 是 follow-up）；新规则在 wrapper-fanout 容器内同样适用（每个 clarify-cross-agent 节点都按 ≤1
  来源 / ≤1 目标 校验）。
