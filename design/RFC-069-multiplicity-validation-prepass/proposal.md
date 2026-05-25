# RFC-069 Proposal — Multiplicity Validation Pre-pass（多 attachment 校验前置化）

> 状态：Draft（2026-05-26）
> Owner：—
> 关联文档：[design.md](./design.md)、[plan.md](./plan.md)
> 基线 RFC：[RFC-063 clarify-single-agent-attachment](../RFC-063-clarify-single-agent-attachment/proposal.md)（G1/G2/G3）、[RFC-064 unified-clarify-runtime](../RFC-064-unified-clarify-runtime/proposal.md)（§7.1 follow-up gap）

## 1. 背景

RFC-063 把"一个 clarify 节点只能挂一个 agent / 一个 agent 不能挂多个 clarify 节点"从隐性假设抬升为
validator 硬约束（G1 + G2 + G3 + 旧 `clarify-multiple-clarify-on-same-agent`）。RFC-064 sweep 期间
（design/RFC-064-unified-clarify-runtime/proposal.md §7.1）发现现行实现有 3 个结构问题：

### 1.1 现状（commit `7975d25` 时点）

**`workflow.validator.ts` §4c / §4d 两块平行 case block 各放各的规则**：

```
§4c case 'clarify':                                §4d case 'clarify-cross-agent':
  - G1: clarify-multiple-source-agents               - G2: cross-clarify-multiple-questioners
  - multi-clarify-on-same-agent ← 共享 predicate       - G3: cross-clarify-multiple-designers
    (e.source.portName === '__clarify__'              - ❌ 缺 multi-clarify-on-same-agent 检查
     && e.target.nodeId !== node.id)
  - clarify-self-loop                                - cross-clarify-not-in-loop
  - clarify-input-must-be-agent                      - cross-clarify-input-must-be-agent
```

### 1.2 三个结构问题

**问题 A（漏覆盖）**——`clarify-multiple-clarify-on-same-agent` 规则的 predicate 用 `__clarify__` 共享源端口、
不看 target kind 所以两类 NodeKind 都通杀，**但物理位置只在 §4c 块内**。意味着：

- 工作流里**完全没有 self-clarify 节点**、agent 只挂到 2+ cross-clarify 节点 → §4c 不触发 → 规则永不跑 →
  "agent → 多 cross-clarify"漏网静默通过
- agent emit 单条 `<workflow-clarify>` envelope 时 framework 无法区分目的地（runtime 取第一条
  `__clarify__` 出边、其余静默丢），行为未定义

**问题 B（平行 duplicate）**——同样语义"一个 X 节点只挂一个 agent"被分两块代码各写一份：

- G1（`clarify-multiple-source-agents`）在 §4c，扫 self-clarify 节点入边 source agent set
- G2（`cross-clarify-multiple-questioners`）在 §4d，扫 cross-clarify 节点 questions 端口入边 source agent set

两条规则字面 ≈ 90% 重叠、message 模板手工对齐、新增 multiplicity 规则要同步改两处。

**问题 C（没有 NodeKind 无关的 pre-pass 入口）**——现行 validator 是 `for (node of definition.nodes) switch (kind)`
模式，所有规则按 NodeKind 分支。某些规则本质上是"agent 的拓扑 invariant"（不属于任何特定 clarify NodeKind），
没地方放、被迫塞进某个 case block 借壳。

## 1.1 为什么现在做（RFC-064 落地后启动）

- RFC-064 把 clarify 运行时状态统一了（单计数器 / 单 service / 单 mint 算法）；validator 物理结构是最后一处"分两块平行写"的层
- §7.1 漏网过渡期可能引入用户实际触发的 bug（虽然概率低、但发生后 silent fail 难诊断）
- RFC-064 在 service 层已经证明 "extract shared helper → 单源真理"的模式可行；validator 层用同样模式
- 不做的代价：未来每加一条"agent-level multiplicity"规则都要继续在 §4c / §4d 各写一份（O(N) 新规则数）

## 1.2 不动哪些地方

- **不动 NodeKind**——`clarify` / `clarify-cross-agent` 两类节点的画布契约保持；与 RFC-064 §1.2 决策对齐
- **不动现有错误码 + message 字面量**——`clarify-multiple-source-agents` / `cross-clarify-multiple-questioners` / `cross-clarify-multiple-designers` / `clarify-multiple-clarify-on-same-agent` 4 个错误码字面量 + message 文案字节级守恒（含冲突 agent id 字典序排列）；外部 editor 跳转 / i18n / 测试 enum 守门零退化
- **不动 G3 `cross-clarify-multiple-designers`**——G3 是 cross-clarify 节点的 `to_designer` 出边方向规则，
  不属于"agent-level multiplicity"范畴（多个 agent 作为 destination 不是 attachment 拓扑），仍留在 §4d
- **不动其它非 multiplicity 规则**：`clarify-self-loop` / `clarify-input-must-be-agent` / `cross-clarify-not-in-loop` /
  `cross-clarify-to_designer-target-must-be-ancestor` / `cross-clarify-self-clarify-mode-warning` 等
  per-NodeKind 拓扑细节规则全部保留在原 case block
- **不动 validator API 签名 / 调用方**——`validateWorkflow(definition)` 公开签名 + 返回 `WorkflowValidationIssue[]` shape 不变
- **不动 RFC-064**——本 RFC 与 RFC-064 文件改动面零重叠（RFC-064 0 行动 validator.ts；本 RFC 0 行动 services / scheduler / migration）

## 2. 目标

### 2.1 做

1. **新增 pre-pass 函数 `validateAgentClarifyMultiplicity(definition, nodes, edges): WorkflowValidationIssue[]`**
   在 `workflow.validator.ts` 中，scan agent set 的 `__clarify__` 出边拓扑：
   - 收集每个 agent 的 `__clarify__` 出边集合（不论 target kind）
   - 对每个有 ≥ 2 条出边的 agent → emit `clarify-multiple-clarify-on-same-agent`（含全部 target NodeId 字典序）
   - 收集每个 clarify NodeKind 节点的 source agent set（去重）→ 多 agent 时 emit `clarify-multiple-source-agents`
   - 收集每个 cross-clarify NodeKind 节点的 questions 端口 source agent set（去重）→ 多 agent 时 emit `cross-clarify-multiple-questioners`

2. **删除 §4c case 块内 multi-clarify-on-same-agent + G1 规则**——移到 pre-pass

3. **删除 §4d case 块内 G2 规则**——移到 pre-pass；G3 留在 §4d（不是 attachment-on-agent 规则）

4. **`validateWorkflow` 主函数**调用 pre-pass 一次：把 `validateAgentClarifyMultiplicity(...)` 结果合入 issues
   数组，**位置在 §4c / §4d case 循环之前**——理由：让 attachment 错误先报、后续 per-kind 拓扑规则可信
   "至少 attachment 拓扑正确"。

5. **解决 §7.1 漏网（pure cross+cross 场景）**——通过 pre-pass 自然覆盖：扫 agent 的 `__clarify__` 出边
   不依赖工作流里有没有 self-clarify 节点存在。原 §7.1 写到要加 G4 `cross-clarify-multiple-cross-on-same-agent`
   独立错误码——pre-pass 模式下**不需要单独 G4**：所有"agent 多挂"情形统一报 `clarify-multiple-clarify-on-same-agent`，
   message 中 target id 列表显示具体冲突节点（self / cross 混合 / 纯 cross 都自然涵盖）。

6. **测试加固**——新增至少 6 个 case 覆盖新增覆盖面（纯 cross+cross / 跨 case block 调用顺序 / pre-pass 与 per-kind 规则的去重）；既有 RFC-063 9 case + RFC-056 既有 validator 套件**字节级守恒**（错误码 + message 字面量 + pointer 字段）

### 2.2 不做

- **不合 NodeKind**——保持画布契约二分（与 RFC-064 §1.2 决策对齐）
- **不动错误码字面量**——4 个既有 code 全部保留（含 message 模板）
- **不动 G3**——cross-clarify 的 `to_designer` 出边 multiplicity 不是 "agent-level attachment"，留在 §4d
- **不引入新错误码**——§7.1 提到的 G4 `cross-clarify-multiple-cross-on-same-agent` **不实施**，因为 pre-pass
  自然涵盖 + 报既有 `clarify-multiple-clarify-on-same-agent` code 让用户看到的错误码体验一致
- **不重构其它 validator 规则**——只移这 3 条 multiplicity（G1 + G2 + multi-clarify-on-same-agent）
- **不动 frontend canvas drag helpers**——drag helper 的"前置 guard"行为（commit `7975d25`）继续独立，
  在 canvas 层提供红色 dashed 拒收 UX；validator 层作为最终守门、互补
- **不动 RFC-063 验收 case**——RFC-063 测试套件 byte-level 守恒（错误码 + message）

## 3. 用户故事

> 全部用户故事的核心断言：**与 RFC-069 上线前面向用户层 validator 报错字节级守恒**——错误码 / message 文案 / pointer
> 字段 / 出现顺序全部不变。唯一新可观察行为是"agent → 多 cross-clarify 节点（无 self-clarify）"过去 silently 通过，
> 现在正确报错。

**S1（self-only multi-clarify，byte-level 守恒）**

agent A 同时挂到 2 个 self-clarify 节点 N1 / N2 → 保存触发 validator → 报错 `clarify-multiple-clarify-on-same-agent`，
message 含 N1+N2 字典序、pointer 指 N1。RFC-069 上线前后字节完全一致。

**S2（self+cross 混合 multi-clarify，byte-level 守恒）**

agent A 同时挂到 1 个 self-clarify N1 + 1 个 cross-clarify N2 → 报错 `clarify-multiple-clarify-on-same-agent`，
message 含 N1+N2 字典序。字节守恒。

**S3（同 self-clarify 节点多 agent 挂接，byte-level 守恒）**

self-clarify 节点 N 入边 questions 端口接到 agent A + agent B → 报错 `clarify-multiple-source-agents`，
message 含 A+B 字典序、pointer 指 N。字节守恒。

**S4（同 cross-clarify 节点多 agent 挂接，byte-level 守恒）**

cross-clarify 节点 N 入边 questions 端口接到 agent A + agent B → 报错 `cross-clarify-multiple-questioners`，
message 含 A+B 字典序、pointer 指 N。字节守恒。

**S5（cross-clarify 节点 `to_designer` 出边接多 designer，byte-level 守恒）**

cross-clarify 节点 N 的 `to_designer` 出边接到 designer X + designer Y → 报错 `cross-clarify-multiple-designers`。
G3 在 §4d 中保持原位置不动（不是 agent-attachment 规则）。字节守恒。

**S6（pure cross+cross 漏网修复，新可观察行为）**

工作流**完全没有 self-clarify 节点**、agent A 同时挂到 2 个 cross-clarify 节点 N1 / N2 → 

- **RFC-069 上线前**：silently 通过 validator → runtime 取第一条 `__clarify__` 出边、A 的 envelope
  只送到 N1、N2 永远收不到，行为未定义
- **RFC-069 上线后**：报错 `clarify-multiple-clarify-on-same-agent`，message 含 N1+N2 字典序、pointer 指 N1

C 守门测试 `multiplicity-pure-cross-coverage.test.ts` 锁定此行为。

## 4. 验收标准

### 功能

- **A1（self-only multi-clarify byte-level）**：S1 错误码 / message / pointer 字节级守恒
- **A2（self+cross multi-clarify byte-level）**：S2 字节守恒
- **A3（self 单节点 multi-agent byte-level）**：S3 字节守恒
- **A4（cross 单节点 multi-agent byte-level）**：S4 字节守恒
- **A5（G3 不动）**：S5 字节守恒——G3 保留在 §4d 中、行为不变
- **A6（pure cross+cross 漏网修复）**：S6 由 silent 变 fail；C 守门测试覆盖
- **A7（pre-pass 单一调用）**：源代码层 grep 守门——`validateAgentClarifyMultiplicity` 在 `workflow.validator.ts` 内仅定义 1 次、被 `validateWorkflow` 调用 1 次；§4c / §4d case 块内 multiplicity-on-agent 规则函数体 grep 不到（旧实现位置已删）
- **A8（错误码 enum 不变）**：`cross-clarify-validator-rules.test.ts` enum 守门 10 → 10（不增不减）
- **A9（既有 RFC-063 测试零退化）**：`workflow-validator-clarify.test.ts` + `workflow-validator-cross-clarify-rfc056.test.ts` 既有 9 case 全绿
- **A10（既有 RFC-056 validator 测试零退化）**：相关 validator 套件零退化

### 非功能

- **B1** `bun run typecheck && bun run test && bun run format:check` 全绿
- **B2** PR-A baseline 既有套件 + 新增 ≥ 6 case 单独 push CI 全绿；PR-B 重构后字节级 diff = 0
- **B3** backend tests ≥ +6（新 case）；shared 0；frontend 0
- **B4** 不引入 e2e；既有 RFC-056 cross-clarify.spec.ts 继续守门
- **B5** validator.ts 单文件 LOC：当前 ~1200 行；预估变化 -50 ~ +30 LOC（删 3 处规则身体 + 加 pre-pass 函数）

### 回归防护（C 守门）

- **C1（既有 9 case 字节守恒）**：`workflow-validator-clarify.test.ts` + `workflow-validator-cross-clarify-rfc056.test.ts` 既有 case 全跑、错误码 + message 字节 diff = 0
- **C2（pure cross+cross 覆盖）**：`multiplicity-pure-cross-coverage.test.ts`（新）3 case——纯 cross+cross 报错 + 工作流无 self-clarify 时 pre-pass 仍触发 + 错误 message 字典序含两 cross-clarify NodeId
- **C3（pre-pass 单源真理 grep 守门）**：`multiplicity-prepass-singleton.test.ts`（新）2 case——`validateAgentClarifyMultiplicity` 函数定义 grep ≥ 1；§4c / §4d case 块内多 attachment 规则 grep ≤ 0
- **C4（pre-pass 与 per-kind 去重）**：`multiplicity-prepass-no-duplicate.test.ts`（新）1 case——同一个错误不能 pre-pass + per-kind 两边都报（避免重复）
- **C5（enum 守门）**：`cross-clarify-validator-rules.test.ts` 10 codes 列表保持不变

## 5. 关键技术选型理由

1. **pre-pass vs 共享 helper 留在 case 块内**：选 **pre-pass**。理由：pre-pass 让 attachment 规则成为
   NodeKind 无关的一级公民；case 块内调用 helper 是 W2 模式（中间形态），仍要 2 处 report、容易引入
   重复报错。pre-pass 一次 scan、一处 report、最干净

2. **是否新增 G4 错误码**：选**不新增**。理由：用户视角"agent 同挂多 clarify"是单一错误概念，
   不应该按"被挂的是 self / cross / mixed"分多个错误码。沿用 `clarify-multiple-clarify-on-same-agent`
   message 中列出 target NodeId 让用户看到具体冲突即可

3. **G3 是否一起搬到 pre-pass**：选**不搬**。理由：G3 是 cross-clarify `to_designer` 出边方向 multiplicity，
   不是"agent attachment"语义；保留在 §4d 内与其它 cross-clarify-only 拓扑规则共置更直观

4. **PR 拆分：单 PR vs PR-A baseline + PR-B 重构**：选**单 PR**。理由：本 RFC 范围小（只动 validator.ts
   单文件 + 加几个 case），不需要 RFC-058 / RFC-064 那种"PR-A baseline 锁全行为 + PR-B 重构"的成本
   分摊；RFC-063 现有套件 + 新 6 case 直接守门即可

5. **是否合 RFC-064 PR-C 顺手做**：选**独立 RFC**。理由：RFC-064 是 cci 错位修复，本 RFC 是 validator 重构，
   两者 commit log 应清晰分离；reviewer 在 RFC-064 PR-B 已经评审了 ~3000 行改动，混 validator 重构会
   分散注意力；用户 round 5 / round 8 已经明确"RFC-064 → RFC-069 顺序"

## 6. 与其它 RFC 的关系

- **RFC-063 clarify-single-agent-attachment**：本 RFC 的直接后置。G1/G2/multi-clarify-on-same-agent 三条规则
  从 case 块搬到 pre-pass；G3 不动。所有 RFC-063 既有 case **字节级守恒**
- **RFC-064 unified-clarify-runtime**：本 RFC 与 RFC-064 文件改动面**零重叠**（RFC-064 0 行动 validator；本 RFC 0 行动 services/scheduler/migration）；顺序串行即可、无返工
- **RFC-056 cross-clarify**：cross-clarify NodeKind 拓扑规则中只有 G2 被搬走、其它（`cross-clarify-not-in-loop` / `cross-clarify-to_designer-target-must-be-ancestor` / etc.）保留在 §4d 内
- **RFC-023 self-clarify**：self-clarify NodeKind 拓扑规则中只有 G1 + multi-clarify-on-same-agent 被搬走、其它（`clarify-self-loop` / `clarify-input-must-be-agent`）保留在 §4c 内
- **RFC-053 lifecycle hardening**：validator 与 lifecycle invariant 解耦、本 RFC 0 触及

## 7. 风险

| 风险 | 评估 | 缓解 |
|---|---|---|
| pre-pass 报错与 per-kind 规则报错重复 → 同一错误被报两次 | 低：pre-pass 报完后 §4c / §4d 已删原规则、不可能重复 | C4 守门测试 + grep guard `multiplicity-prepass-singleton.test.ts` |
| pre-pass 报错顺序与既有顺序不一致 → 测试 expect.toContainEqual 不依赖顺序、但前端 editor 依赖第一条错误跳转 | 低：pre-pass 在 case 循环之前跑 → 多 attachment 报错最先出现、与既有"§4c 自然顺序"一致 | 既有 9 case 中含错误顺序断言的全跑、看是否需要调整 |
| §7.1 漏网修复后用户工作流之前 silent 通过现在报错 → 行为变更 | 中：用户工作流如已被错误拓扑构造，保存时会突然失败 | S6 故事文档化；前端 editor 错误 banner 提示 message + pointer 让用户能定位修复；不需要 migration |
| pre-pass 加 NodeKind 无关入口后未来其它 multiplicity 规则误归入 → scope creep | 低：本 RFC 只移 3 条规则，pre-pass 函数命名 + 文档明确"only agent-level clarify attachment" | function name + jsdoc 明确职责边界 |
| 既有错误 message 字面量字节级守恒——pre-pass 重写 message 模板时引入空格 / 标点 diff | 中：手工字符串拼接易出错 | C1 比对既有 9 case 错误 message 字面量 + 1 个 RFC-056 case；任何 diff 触发返工 |

## 8. 后续可能的延展（v1 不做）

- 把其它"全局 graph invariant"规则（譬如 review 节点 multi-source agent 检查、wrapper 嵌套深度限制）也移到 pre-pass
- pre-pass 系统化、引入 `WorkflowValidationPass` 接口让外部插件式注册（v1 是直接调用、足够）
- pre-pass 错误 message 国际化 / i18n key（v1 仍按现有英文 message 字面量）
- 给 G3（`cross-clarify-multiple-designers`）做对称的"designer 不能同时被多 cross-clarify 指"的对偶规则——本 RFC 不做、与 RFC-056 §6 多源等待 banner 模式可能冲突，需独立评估
