# RFC-063 — Design

## 改动总览

只动一个文件：`packages/backend/src/services/workflow.validator.ts`，向既有 §4c clarify 段落与 §4d cross-clarify
段落各注入 multiplicity 校验逻辑。零 schema / migration / runtime / frontend 改动。

| 文件                                                              | 改动                                                                                                                                   |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/backend/src/services/workflow.validator.ts`             | §4c 段插入 `clarify-multiple-source-agents` 规则；§4d 段插入 `cross-clarify-multiple-questioners` + `cross-clarify-multiple-designers` |
| `packages/backend/tests/workflow-validator-clarify.test.ts`       | +2 case（dedup happy / multi-agent reject）                                                                                            |
| `packages/backend/tests/workflow-validator-cross-clarify-rfc056.test.ts` | +4 case（dedup questioner / multi-questioner / dedup designer / multi-designer）                                                       |
| `packages/backend/tests/cross-clarify-validator-rules.test.ts`    | 把 2 新规则加入 enum 守门列表（防止 grep guard 漏报）                                                                                  |

## 规则细节

### G1 — `clarify-multiple-source-agents`（§4c）

**触发条件**：`clarify` 节点 `inboundOnQuestions` 边集合中，去重后的 `agentSourceIds.size > 1`。

**位置**：`workflow.validator.ts` §4c 现有循环内，在 `for (const agentId of agentSourceIds)`
反向规则之前增加一条独立分支：

```ts
// G1: a single clarify node must attach to at most one agent.
if (agentSourceIds.size > 1) {
  const sorted = [...agentSourceIds].sort()
  issues.push({
    code: 'clarify-multiple-source-agents',
    message: `clarify node '${node.id}' has inbound 'questions' edges from multiple agents (${sorted.join(', ')}); only one agent may be attached to a clarify node`,
    pointer: node.id,
  })
}
```

**dedup 语义**：`agentSourceIds: Set<string>` 已用 `src.id` 作为键去重；同一 agent 通过两条重复 edge 进入只算 1。
非 `agent-single` 来源（`clarify-target-not-agent` 报过）在 `continue` 处已跳过，不进入计数。

### G2 — `cross-clarify-multiple-questioners`（§4d）

**触发条件**：`clarify-cross-agent` 节点 `inboundOnQuestions` 边集合中，去重后的合法
`agent-single` source id 数 > 1。

**位置**：`workflow.validator.ts` §4d 现有 `inboundOnQuestions` 循环之后，在 `questionerId` 派生完成后立刻
做计数。需要把现有"`questionerId` 在 loop 里被覆盖"的反模式改为先收集 set，循环结束再写 `questionerId`
（取 set 的任一元素，让后续 ancestor / self-review 校验仍能跑）。

```ts
const questionerCandidateIds = new Set<string>()
const questionerAgentNamesById = new Map<string, string | undefined>()
for (const e of inboundOnQuestions) {
  const src = nodeById.get(e.source.nodeId)
  // ...（保留现有 missing / target-not-agent-single 分支）
  questionerCandidateIds.add(src.id)
  questionerAgentNamesById.set(src.id, readString(src, 'agentName'))
}
// G2: a single cross-clarify must attach to at most one questioner agent.
if (questionerCandidateIds.size > 1) {
  const sorted = [...questionerCandidateIds].sort()
  issues.push({
    code: 'cross-clarify-multiple-questioners',
    message: `clarify-cross-agent node '${node.id}' has inbound 'questions' edges from multiple agents (${sorted.join(', ')}); only one questioner agent allowed per cross-clarify node`,
    pointer: node.id,
  })
}
// 保留后续 ancestor / self-review / auto-edge-deleted 规则的输入。
let questionerId: string | undefined
let questionerAgentName: string | undefined
if (questionerCandidateIds.size >= 1) {
  // 字典序最小，结果稳定，便于测试断言。
  questionerId = [...questionerCandidateIds].sort()[0]
  questionerAgentName = questionerAgentNamesById.get(questionerId)
}
```

**dedup 语义**：与 G1 同；同一 agent 重复 edge 不算多。`target-not-agent-single` 的边不进入 set。

**和现有 §4d 其他规则的关系**：
- `cross-clarify-target-not-agent-single` 仍按 per-edge 触发（多次同 source 重复报错也合理，因为
  edge id 不同）。
- `cross-clarify-target-not-ancestor` / `cross-clarify-self-review-warning` / `cross-clarify-auto-edge-deleted`
  都消费 `questionerId` 单值；选字典序最小的稳定值即可，多 questioner 时 G2 已经报 error，后续这些 warning
  按"任选一个 questioner"评估属合理 fallback（用户必须先修 G2，warning 是 best-effort）。

### G3 — `cross-clarify-multiple-designers`（§4d）

**触发条件**：`clarify-cross-agent` 节点的 `outboundEdges` 中 `e.source.portName === 'to_designer'`
集合，按 `e.target.nodeId` 去重后再过滤为合法 `agent-single` 节点，剩余 unique target id 数 > 1。

**位置**：`workflow.validator.ts` §4d 现有 `toDesignerOut`（warning 缺失）规则之后、`cross-clarify-target-not-ancestor`
循环之前，单独一段：

```ts
// G3: a single cross-clarify must direct to_designer at most one designer agent.
const toDesignerTargetIds = new Set<string>()
for (const e of toDesignerOut) {
  const tgt = nodeById.get(e.target.nodeId)
  if (tgt === undefined) continue            // target-missing 已由前面 reference 规则报
  if (tgt.kind !== 'agent-single') continue  // 非 agent-single target 现有规则也已经会拦
  toDesignerTargetIds.add(tgt.id)
}
if (toDesignerTargetIds.size > 1) {
  const sorted = [...toDesignerTargetIds].sort()
  issues.push({
    code: 'cross-clarify-multiple-designers',
    message: `clarify-cross-agent node '${node.id}' has 'to_designer' edges to multiple agents (${sorted.join(', ')}); only one designer agent allowed per cross-clarify node`,
    pointer: node.id,
  })
}
```

**dedup 语义**：以 `tgt.id`（target 节点 NodeId）为键。同一 designer 节点被 2 条 edge 指 = 1 designer。
非 `agent-single` target 不进入计数（其他规则会报）。

**和 §4d 其他规则的关系**：
- `cross-clarify-manual-edge-missing` 仍按 0 触发（warning）；G3 与之不冲突。
- `cross-clarify-target-not-ancestor` 循环每条 edge 单独评估；多 designer 时每条都各自跑 ancestor 检查（warning）
  ，叠加 G3 error 给出完整信号。
- `cross-clarify-self-review-warning` 每条 to_designer 边的 designer agentName 对比 questionerAgentName；
  多 designer + 多 questioner 双 error 时这条 warning 评估仍有意义（best-effort），无负面交互。

## 测试策略

### 新文件无（沿用现有两套件）

**`workflow-validator-clarify.test.ts`** 新增：

```ts
test('one clarify node with duplicate edges from same agent is allowed (dedup)', () => { ... })
test('one clarify node attached to two different agents is rejected (G1)', () => { ... })
```

**`workflow-validator-cross-clarify-rfc056.test.ts`** 新增：

```ts
test('one cross-clarify with duplicate questions edges from same agent is allowed (G2 dedup)', () => { ... })
test('one cross-clarify with questions edges from two different agents is rejected (G2)', () => { ... })
test('one cross-clarify with two to_designer edges to same designer is allowed (G3 dedup)', () => { ... })
test('one cross-clarify with two to_designer edges to different designers is rejected (G3)', () => { ... })
```

每条 reject case 同时断言 `message` 含 conflict agent id 列表（字典序），让用户能定位。

**`cross-clarify-validator-rules.test.ts`** 守门 enum 扩展：

```ts
const RFC056_VALIDATOR_RULES = [
  // ...existing 7 rules...
  'cross-clarify-multiple-questioners',  // RFC-063 G2
  'cross-clarify-multiple-designers',    // RFC-063 G3
] as const
```

（若该守门测试 hardcoded 长度 7，需要同步改为 9，message 注明 "+2 from RFC-063".）

### 回归锁

- `workflow-validator.test.ts`（broad happy path 与混合 case）—— 跑一遍确认无误报。
- `workflow-validator-cross-clarify-rfc056.test.ts` 第一条 happy path 的 `.not.toContain` 列表新增
  `'cross-clarify-multiple-questioners'` / `'cross-clarify-multiple-designers'`，明确锁住 1q + 1d 配置不会
  误伤。
- RFC-056 既有 "多源等待 banner" 模式（多 cross-clarify → 单 designer）：在 cross-clarify 测试套件加 1 case
  `multiple cross-clarify nodes pointing to same designer is allowed`，每个 cross-clarify 自己的 to_designer
  集合 size = 1，G3 不应误报。

### Frontend 守门

- frontend 现有 validation banner / inspector 用 i18n key `workflow.validation.<code>` 渲染时，2 个新 code
  会落到 fallback message（直接展示 issue.message）。短期不强求 i18n 翻译；本 RFC plan §T1 把"新增 i18n key
  zh-CN / en-US"标记为 nice-to-have，不阻塞合并。

## 失败模式 / 边界

1. **重复 edge id（同一 source-target 对，edge id 不同）**：dedup 用 source.nodeId / target.nodeId 而不是 edge id，
   多余 edge 不报错；现有 `edge-duplicate` 规则（若存在）按 edge id 报。
2. **未知 agent 引用**：`reference-* missing` 类规则在更早阶段已经报错；进入 §4c / §4d 的 src/tgt 已经过滤 undefined。
3. **wrapper-fanout 容器内的 clarify-cross-agent**：RFC-060 PR-E 之后 cross-clarify 不允许 inside fanout
   （由 fanout cross-cutting 规则锁住）；本 RFC 不需要新规则覆盖该交互。
4. **同 agent 名但不同 NodeId 的两个 agent-single 节点连同一 clarify**：dedup 用 NodeId 不用 agentName，
   两个不同 node = 2 agent → G1/G2 都会报。这是正确的语义（用户复制了同一个 agent-single 节点视觉上看似一致但
   是两个独立节点，需要选其一）。
5. **Aggregator agent 作为 designer**：RFC-060 aggregator agent 角色由 frontmatter `role: 'aggregator'`
   标识，本 RFC 不区分 agent role；validator 只看节点 NodeKind = agent-single。

## 性能

新增 3 个 Set 构造 + size 比较，O(E) per validator run。当前 validator 在 hot path 已经 O(N+E) 多遍扫边，
新增成本可忽略。

## 部署

- 单 PR，单 commit；prefix `feat(backend): RFC-063 clarify single-agent attachment`.
- 落地不需要 migration；旧 workflow 文档读取时不影响（仅 write/validate 路径校验）。
- 既存 DB 中可能已有违规图（如果有人手动构造）：本 RFC 落地后这些图在下次 PUT 时会被拒；GET 仍能返回（GET
  不跑 validator）。如有遗留违规图，editor banner 会标红提示用户修复后再保存。
