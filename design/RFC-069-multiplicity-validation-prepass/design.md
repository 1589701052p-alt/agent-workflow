# RFC-069 Design — Multiplicity Validation Pre-pass：技术设计

> 状态：Draft（2026-05-26）
> 关联文档：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 复用基线：[RFC-063](../RFC-063-clarify-single-agent-attachment/design.md)、[RFC-064](../RFC-064-unified-clarify-runtime/proposal.md) §7.1

## 1. 概览

把 `workflow.validator.ts` 中"agent-level clarify attachment multiplicity"3 条规则（G1 + G2 + `clarify-multiple-clarify-on-same-agent`）
从 §4c / §4d case block 内抽出为 NodeKind 无关的 pre-pass 函数，在 `validateWorkflow` 主循环之前调用一次。

数据流：

```
validateWorkflow(definition):
  let issues: WorkflowValidationIssue[] = []
  let nodesById = ...
  let edges = ...

  // ─── pre-pass (RFC-069) ───
  issues.push(...validateAgentClarifyMultiplicity({ nodes, edges }))

  // ─── per-NodeKind case loop（既有结构） ───
  for (const node of nodes) {
    switch (node.kind) {
      case 'clarify':           // §4c — multi-clarify-on-same-agent / G1 已被搬走
        ...                     //       保留 self-loop / input-must-be-agent 等
      case 'clarify-cross-agent': // §4d — G2 已被搬走
        ...                     //       保留 G3 / not-in-loop / to_designer-ancestor 等
      ...
    }
  }
  return issues
```

技术上分 3 块：

1. **新增 pre-pass 函数** `validateAgentClarifyMultiplicity({ nodes, edges })`：单 scan、emit 0-N 个 issue
2. **删 §4c / §4d 中的 G1 + G2 + multi-clarify-on-same-agent 规则块**：保留其它 per-NodeKind 规则
3. **`validateWorkflow` 主函数加 pre-pass 调用**：插在 case 循环之前

## 2. pre-pass 函数实现

`packages/backend/src/services/workflow.validator.ts`（新增函数体 ≈ 70 行）：

```ts
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { CLARIFY_SOURCE_PORT_NAME } from '@agent-workflow/shared'

/**
 * RFC-069: NodeKind-agnostic pre-pass for agent-level clarify attachment
 * multiplicity rules. Runs before per-NodeKind case loop in validateWorkflow
 * so attachment errors are reported first, and per-NodeKind topology checks
 * can assume baseline attachment topology correctness.
 *
 * Three rule types emitted:
 *
 *  1. `clarify-multiple-clarify-on-same-agent` — agent has ≥ 2 outbound
 *     `__clarify__` edges (target may be any combination of self-clarify
 *     and cross-clarify NodeKind). Closes RFC-064 §7.1 gap (pure cross+cross
 *     was silent before).
 *
 *  2. `clarify-multiple-source-agents` — self-clarify node 'questions' port
 *     has ≥ 2 distinct source agents (RFC-063 G1).
 *
 *  3. `cross-clarify-multiple-questioners` — cross-clarify node 'questions'
 *     port has ≥ 2 distinct source agents (RFC-063 G2).
 *
 * Not handled here:
 *
 *  - G3 `cross-clarify-multiple-designers` — `to_designer` outbound edge
 *    rule, not agent attachment. Stays in §4d.
 *  - per-NodeKind topology rules (self-loop / not-in-loop / etc.) — stay
 *    in case blocks.
 */
export function validateAgentClarifyMultiplicity(args: {
  nodes: ReadonlyArray<WorkflowNode>
  edges: ReadonlyArray<WorkflowEdge>
}): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = []
  const nodesById = new Map(args.nodes.map((n) => [n.id, n]))

  // Rule 1: agent has ≥ 2 outbound `__clarify__` edges → multi-clarify-on-same-agent
  const clarifyEdgesByAgent = new Map<string, WorkflowEdge[]>()
  for (const e of args.edges) {
    if (e.source.portName !== CLARIFY_SOURCE_PORT_NAME) continue
    const list = clarifyEdgesByAgent.get(e.source.nodeId) ?? []
    list.push(e)
    clarifyEdgesByAgent.set(e.source.nodeId, list)
  }
  for (const [agentId, edges] of clarifyEdgesByAgent) {
    const targetIds = [...new Set(edges.map((e) => e.target.nodeId))]
    if (targetIds.length > 1) {
      targetIds.sort()
      // Pointer: first target dictionary-min (matches existing §4c message format).
      issues.push({
        code: 'clarify-multiple-clarify-on-same-agent',
        message: `agent '${agentId}' already has a clarify channel; remove the other clarify node before adding '${targetIds[0]}'`,
        pointer: targetIds[0],
      })
    }
  }

  // Rule 2 + 3: clarify node has ≥ 2 distinct source agents
  // (folds RFC-063 G1 + G2 since they share predicate structure)
  for (const node of args.nodes) {
    if (node.kind !== 'clarify' && node.kind !== 'clarify-cross-agent') continue
    const sourceAgents = new Set<string>()
    for (const e of args.edges) {
      if (e.target.nodeId !== node.id) continue
      if (e.target.portName !== 'questions') continue
      const srcNode = nodesById.get(e.source.nodeId)
      if (!srcNode) continue
      // Only agent-single nodes count (matches existing §4c agentSourceIds.add behavior)
      if (srcNode.kind !== 'agent-single') continue
      sourceAgents.add(srcNode.id)
    }
    if (sourceAgents.size > 1) {
      const sorted = [...sourceAgents].sort()
      const code =
        node.kind === 'clarify' ? 'clarify-multiple-source-agents' : 'cross-clarify-multiple-questioners'
      const msgPrefix =
        node.kind === 'clarify'
          ? `clarify node '${node.id}' has inbound 'questions' edges from multiple agents`
          : `clarify-cross-agent node '${node.id}' has inbound 'questions' edges from multiple agents`
      const msgSuffix =
        node.kind === 'clarify'
          ? `; only one agent may be attached to a clarify node`
          : `; only one questioner agent allowed per cross-clarify node`
      issues.push({
        code,
        message: `${msgPrefix} (${sorted.join(', ')})${msgSuffix}`,
        pointer: node.id,
      })
    }
  }

  return issues
}
```

## 3. validateWorkflow 主函数改造

`workflow.validator.ts` 现状（伪代码）：

```ts
export function validateWorkflow(definition: WorkflowDefinition): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []
  const nodes = definition.nodes ?? []
  const edges = definition.edges ?? []
  // ... [其它 pre-checks 譬如 §4a / §4b 全局检查]

  for (const node of nodes) {
    switch (node.kind) {
      case 'clarify': /* §4c */
      case 'clarify-cross-agent': /* §4d */
      ...
    }
  }
  return { ok: issues.length === 0, issues }
}
```

改造（加 1 行）：

```ts
export function validateWorkflow(definition: WorkflowDefinition): WorkflowValidationResult {
  const issues: WorkflowValidationIssue[] = []
  const nodes = definition.nodes ?? []
  const edges = definition.edges ?? []
  // ... [其它 pre-checks]

  // RFC-069 pre-pass: agent-level clarify attachment multiplicity
  issues.push(...validateAgentClarifyMultiplicity({ nodes, edges }))

  for (const node of nodes) {
    switch (node.kind) {
      case 'clarify':           /* §4c — G1 + multi-clarify-on-same-agent 已被搬走 */
      case 'clarify-cross-agent': /* §4d — G2 已被搬走 */
      ...
    }
  }
  return { ok: issues.length === 0, issues }
}
```

## 4. §4c / §4d case 块清理

### 4.1 §4c case 'clarify' 块

**删除**（line 863-893 范围）：

```ts
// ❌ 删
// RFC-063 G1: a single clarify node must attach to at most one agent.
if (agentSourceIds.size > 1) { ... emit clarify-multiple-source-agents ... }

// ❌ 删
// multi-clarify on the same agent
for (const agentId of agentSourceIds) {
  const otherClarifyOnSameAgent = edges.filter(...)
  if (otherClarifyOnSameAgent.length > 0) { ... emit clarify-multiple-clarify-on-same-agent ... }
}
```

**保留**：
- 系统端口 vs 自定义端口检查
- `clarify-input-must-be-agent` 检查（srcNode.kind !== 'agent-single' → emit）
- `clarify-self-loop` 检查
- 其它 self-clarify 拓扑 invariant

注意：`agentSourceIds: Set<string>` 派生计算保留（其它检查可能用到）；只删除 size > 1 + multi-clarify 两段。

### 4.2 §4d case 'clarify-cross-agent' 块

**删除**（line 996-1006 范围）：

```ts
// ❌ 删
// RFC-063 G2: cross-clarify questions port must attach to at most one agent
if (sourceAgents.size > 1) { ... emit cross-clarify-multiple-questioners ... }
```

**保留**：
- G3 `cross-clarify-multiple-designers`（line 1041-1054）
- `cross-clarify-not-in-loop` 警告
- `cross-clarify-to_designer-target-must-be-ancestor` 检查
- `cross-clarify-self-clarify-mode-warning`（designer == questioner 同 agent 警告）
- 其它 cross-clarify 拓扑 invariant

## 5. 测试策略

### 5.1 既有测试零退化（C1 守门）

跑全套既有 validator 测试：

- `workflow-validator-clarify.test.ts`（RFC-063 G1 + multi-clarify-on-same-agent 9 case 全跑）
- `workflow-validator-cross-clarify-rfc056.test.ts`（RFC-056/063 G2/G3 多 case 全跑）
- `cross-clarify-validator-rules.test.ts`（enum 10 codes 守门）

**判据**：错误码 + message 字面量 + pointer 字段字节级 diff = 0。

如果某 case message 顺序变化（例如错误数组中 multi-clarify 错误的相对位置），需评估是否更新测试 expect
顺序——但**不允许**改 message 文本本身。

### 5.2 新增 case（≥ 6 个）

**`multiplicity-pure-cross-coverage.test.ts`**（C2，3 case）：
- pure cross+cross 同一 agent 报错 happy
- 无 self-clarify 节点工作流（pre-pass 仍触发）
- 错误 message 字典序含两 cross-clarify NodeId

**`multiplicity-prepass-singleton.test.ts`**（C3，2 case）：
- 源代码 grep：`validateAgentClarifyMultiplicity` 函数定义出现 ≥ 1 次
- 源代码 grep：旧位置（§4c / §4d case 块内）的 multi-clarify-on-same-agent / G1 / G2 规则 grep ≤ 0 次

**`multiplicity-prepass-no-duplicate.test.ts`**（C4，1 case）：
- 构造同时触发多 attachment + per-kind self-loop 的 case
- 断言 multi-attachment 错误只报 1 次（不会同时出现 pre-pass + 旧 case 重复）

### 5.3 PR 合规

- 单 PR
- `bun run typecheck && bun run test && bun run format:check` 全绿
- 新增 case 全绿
- 既有 RFC-063 + RFC-056 validator 套件零退化

## 6. 源代码层 grep 守门

PR 完工时以下 grep 必须满足：

```bash
# Pre-pass 函数存在且只定义 1 次
grep -c "export function validateAgentClarifyMultiplicity\b" packages/backend/src/services/workflow.validator.ts
# 期望: 1

# 旧 §4c / §4d 中的规则身体已删
grep -n "clarify-multiple-clarify-on-same-agent" packages/backend/src/services/workflow.validator.ts
# 期望: 只在 pre-pass 函数体内出现 1 次 (issues.push); 旧 §4c 位置不应再有

grep -n "clarify-multiple-source-agents" packages/backend/src/services/workflow.validator.ts
# 期望: 只在 pre-pass 函数体内 1 次

grep -n "cross-clarify-multiple-questioners" packages/backend/src/services/workflow.validator.ts
# 期望: 只在 pre-pass 函数体内 1 次

# G3 保留在 §4d
grep -n "cross-clarify-multiple-designers" packages/backend/src/services/workflow.validator.ts
# 期望: 在 §4d case 块内 1 次（位置不动）

# 错误码 enum 不变
grep "cross-clarify-validator-rules.test.ts" 内 10 codes 列表
# 期望: 10 个错误码全保留
```

## 7. 失败模式 / 边界条件

| 场景 | 期望行为 |
|---|---|
| edge.source.portName === '__clarify__' 但 target.nodeId 引用不存在节点 | pre-pass 仍记入 clarifyEdgesByAgent；后续 per-kind 检查发现"target 不存在" 时 emit 标准 dangling-edge 错误（互不影响） |
| 同一 agent 同一 target 节点有 2 条重复 edge | pre-pass 去重后 targetIds.length = 1 → 不报 multi-clarify-on-same-agent（合理：拓扑实际只挂 1 个 target）；其它 dedup 检查（譬如 `clarify-multiple-source-agents` 内部 Set 去重）保留 |
| agent.kind !== 'agent-single'（譬如 wrapper 节点出 `__clarify__` 边——错误拓扑） | pre-pass Rule 1 仍报多 attachment（不看 source kind）；Rule 2/3 跳过（因为 srcNode.kind !== 'agent-single' check）。配合 per-kind `clarify-input-must-be-agent` 报源类型错。两份错误共存合理 |
| 工作流空（无 nodes / 无 edges） | pre-pass 早 return 0 issues；后续 case 循环也 0；行为字节守恒 |
| 一个 agent 同挂 3+ clarify 节点 | targetIds 含 3+ NodeId、字典序排序；message 中 pointer 取首位；错误 1 条（不是 N-1 条） |
| edges 中含 `__clarify__` 出边但 target 是非 clarify NodeKind（譬如手工拼写错连到 review 节点） | Rule 1 仍统计该 edge 入 clarifyEdgesByAgent；如果只有 1 条该 edge 则不报多 attachment；其它检查会报"target 类型不符" |

## 8. 与 RFC-064 / RFC-063 顺序约束

- **RFC-064 → RFC-069**：本 RFC 在 RFC-064 落地后启动；理由：
  - RFC-064 已统一 cci 错位 → validator 重构期不会被运行时 bug 干扰
  - RFC-064 PR-B baseline 锁了 RFC-023 / RFC-056 行为 → 本 RFC 重构副作用如果不小心影响 runtime（理论上不应该），baseline test 也能捕获
  - 两 RFC 文件改动面零重叠

- **RFC-063 → RFC-069**：RFC-063 是直接基线
  - 本 RFC 不引入新错误码（与 RFC-063 enum 一致）
  - 本 RFC 不动 message 字面量（与 RFC-063 文案一致）
  - 本 RFC 不动 G3（保持在 §4d 原位置）

## 9. 估算

- pre-pass 函数实现 + §4c / §4d 清理：0.5 d
- 新增 ≥ 6 case 测试：1 d
- 跑全套既有验证 + 调整顺序敏感断言（如果有）：0.5 d
- 文档收尾 + PR 提交：0.5 d
- **合计 ≈ 2-3 d / 1 PR**

显著小于 RFC-058 / RFC-064，因为：
- 单文件改动（workflow.validator.ts）
- 既有错误码 / message / 测试套件全部字节级守恒
- 不动 runtime / migration / frontend
