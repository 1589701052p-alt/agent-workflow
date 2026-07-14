# RFC-W004 Design - Agent 反问上游 Agent（Clarify-to-Agent）技术设计

> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)
> 基线代码引用以 `file_path:line_number` 标注，实现时以源码为准。

## 1. 概述

新增第 N 类 NodeKind `clarify-to-agent`，实现"B 反问 A、A 自主回答 B、A 不清楚升级问人"的层次化反问。回答者从"人"换成"上游 agent A"，回答载体是新 envelope `<workflow-clarify-answer>`，A 通过重跑产出回答并回流 B。A 升级问人完全复用 RFC-023 self-clarify。

### 1.1 数据流总览

```
                    ┌── to_questioner ──> B.__clarify_response__ ── (B 重跑带回答)
B.__clarify__       │
  └──> [to-agent].questions
        │
        └── to_answerer ──> A.__clarify_request__ ── (A 重跑回答)

A 重跑产物:
  清楚   -> <workflow-clarify-answer>  -> 解析 -> 回流 B
  不清楚 -> <workflow-clarify>          -> A 的 self-clarify park awaiting_human
                                          (人答 A -> A 带 answer 答 B)
```

### 1.2 新增产物清单

| 产物 | 位置 |
| --- | --- |
| NodeKind `clarify-to-agent` | `packages/shared/src/schemas/workflow.ts` NodeKind 联合 |
| 端口常量 | `packages/shared/src/schemas/workflow.ts`（与 RFC-056 常量并列） |
| 节点端口声明 | `packages/shared/src/nodePorts.ts` |
| 自动边构建 | `packages/shared/src/clarify.ts` `buildToAgentAutoEdges` |
| envelope 解析 | `packages/backend/src/services/runner.ts`（`<workflow-clarify-answer>`） |
| envelope schema | `packages/shared/src/clarify.ts` |
| service | `packages/backend/src/services/toAgentClarify.ts`（新建） |
| scheduler 分支 | `packages/backend/src/services/scheduler.ts`（B 提问 dispatch + A 回答 dispatch） |
| validator 规则 | `packages/backend/src/services/workflow.validator.ts` |
| DB migration | `clarify_rounds` 加 kind=`'to-agent'` + 2 列；`node_runs` 加 `to_agent_iteration` |
| lifecycle 转移 | `packages/shared/src/lifecycle.ts` 加 `awaiting_human` |
| rerun cause | `packages/backend/src/services/clarifyRerunLedger.ts` + `nodeRunMint.ts` |
| prompt 注入 | `packages/shared/src/prompt.ts` + `packages/backend/src/services/toAgentClarify.ts`（`## Clarify Request` block） |
| flat block 注入 | `packages/backend/src/services/clarifyQueue.ts`（A 回答作 peer entry） |
| 前端节点 | `packages/frontend/src/components/canvas/nodes/ToAgentClarifyNode.tsx` |
| 前端 inspector | `packages/frontend/src/components/canvas/inspector/ToAgentClarifyEdit.tsx` |

## 2. 接口契约

### 2.1 NodeKind 定义

`packages/shared/src/schemas/workflow.ts` 的 `NodeKind` 联合追加 `'clarify-to-agent'`（与 `'clarify'` / `'clarify-cross-agent'` 并列）。`NODE_KINDS` 常量数组同步追加。

### 2.2 端口常量

`packages/shared/src/schemas/workflow.ts`，与 RFC-056 常量（`:366-375`）并列新增：

```ts
export const TO_AGENT_CLARIFY_INPUT_PORT_NAME = 'questions'        // 复用同名
export const TO_AGENT_OUT_TO_ANSWERER_PORT = 'to_answerer'
export const TO_AGENT_OUT_TO_QUESTIONER_PORT = 'to_questioner'     // 复用同名
export const TO_AGENT_CLARIFY_REQUEST_PORT = '__clarify_request__' // A 的系统输入端口
```

`CLARIFY_RESPONSE_TARGET_PORT_NAME`（`__clarify_response__`，`:298`）复用，不加新常量。

### 2.3 节点端口声明

`packages/shared/src/nodePorts.ts`（RFC-056 在 `:217-225`），新增 to-agent 分支：

```ts
case 'clarify-to-agent':
  return {
    systemInputs: [TO_AGENT_CLARIFY_INPUT_PORT_NAME],           // questions
    systemOutputs: [TO_AGENT_OUT_TO_ANSWERER_PORT, TO_AGENT_OUT_TO_QUESTIONER_PORT],
    userEditableInputs: [],   // 画布不可增减端口
    userEditableOutputs: [],
  }
```

agent-single 的 `systemInputs`（`:155-172` 当前 `[__clarify_response__, __external_feedback__]`）追加 `__clarify_request__`：

```ts
case 'agent-single':
  return {
    systemOutputs: [CLARIFY_SOURCE_PORT_NAME],  // __clarify__
    systemInputs: [
      CLARIFY_RESPONSE_TARGET_PORT_NAME,        // __clarify_response__
      CROSS_CLARIFY_EXTERNAL_FEEDBACK_PORT,     // __external_feedback__
      TO_AGENT_CLARIFY_REQUEST_PORT,             // __clarify_request__  <-- 新增
    ],
    ...
  }
```

`__clarify_request__` 仅当被 ≥1 个 to-agent manual-edge 指向时画布可见（动态注册机制对齐 RFC-056 `__external_feedback__`，`proposal §2.1.3`）。

### 2.4 自动边构建

`packages/shared/src/clarify.ts`，与 `buildCrossClarifyAutoEdges`（`:705-720`）并列新增 `buildToAgentAutoEdges`：

```ts
// 用户从 to-agent 节点 input handle 反向拖到 B -> 框架自动建 2 条边:
//   B.__clarify__           -> to_agent.questions          (B 提问出口)
//   to_agent.to_questioner  -> B.__clarify_response__      (回答回流 B)
export function buildToAgentAutoEdges(toAgentNodeId: string, questionerBId: string): Edge[] {
  return [
    { source: { nodeId: questionerBId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: toAgentNodeId, portName: TO_AGENT_CLARIFY_INPUT_PORT_NAME } },
    { source: { nodeId: toAgentNodeId, portName: TO_AGENT_OUT_TO_QUESTIONER_PORT },
      target: { nodeId: questionerBId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME } },
  ]
}
```

第三条边 `to_agent.to_answerer -> A.__clarify_request__` 由用户手动拖（对齐 RFC-056 手动拖 `to_designer`，`proposal §2.1.3`）。

### 2.5 envelope schema

**提问**（B 侧）：完全 reuse RFC-023 `<workflow-clarify>` JSON schema（`packages/shared/src/clarify.ts` ClarifyQuestionSchema），问题数上限沿用 RFC-056 的 1+（cross 模式不截断，`runner.ts:1206`）。

**回答**（A 侧，新增）：`packages/shared/src/clarify.ts` 新增 schema：

```ts
// <workflow-clarify-answer> envelope body schema
// A 对 B 问题的回答。两种形态:
//   1. 整体 markdown 文本（A 自由作答，body 是一段 markdown）
//   2. per-question 结构化（A 逐题作答，body 是 JSON { answers: [{ id, text }] }）
// v1 支持形态 1（markdown 文本），形态 2 留后续延展（见 proposal §8）。
export const ClarifyAnswerEnvelopeSchema = z.object({
  markdown: z.string().min(1),  // A 的回答 markdown，注入 B 的 flat block 作 peer entry
})
```

**协议块**（A 侧 prompt 末尾 auto-append，见 §6）：

```
## Clarify Request
You are being asked a clarification question by downstream agent '{questionerNodeId}'.
Answer each question; your answer MUST be emitted as a <workflow-clarify-answer> envelope:
<workflow-clarify-answer>
{ "markdown": "<your answer markdown here>" }
</workflow-clarify-answer>
If you genuinely cannot answer (you also don't know), emit <workflow-clarify> to ask a human
(via your self-clarify channel). You MUST emit exactly one of these two envelopes this run;
emitting both, or emitting <workflow-output> alone, will fail this run.

{per-question list: id / title / kind / options}
```

### 2.6 DB schema 变更

**migration `0090`**（journal bump，对齐 RFC-W001 起的 Windows 兼容基线 + 现有最高 migration 号；实现时以 schema.ts 顶部 journal 计数为准）：

1. `clarify_rounds` 表（`packages/backend/src/db/schema.ts:1461-1544`）：
   - `kind` 枚举 CHECK 约束加 `'to-agent'`（当前 self/cross，`:1468`）。
   - 新增列 `answerer_node_id TEXT`（A 的 nodeId，self/cross 时 NULL）。
   - 新增列 `answerer_node_run_id TEXT`（A 回答 run 的 id，self/cross 时 NULL）。
   - 既有 self/cross 行新列默认 NULL，零 backfill 数据风险。

2. `node_runs` 表新增列 `to_agent_iteration INTEGER NOT NULL DEFAULT 0`（A 被反问轮次，对齐 RFC-056 `cross_clarify_iteration`，`:1443` 附近）。

3. workflow `$schema_version` bump（当前最高以 schema.ts 为准；本 RFC 仅追加 to-agent 节点形态，旧 workflow 透明上提）。

**不新建表**：to-agent session 只进 `clarify_rounds`（kind=`'to-agent'`），不碰 legacy `clarify_sessions` / `cross_clarify_sessions` 双写（RFC-058 unified 表是单一事实源）。

### 2.7 lifecycle 转移表扩展（设计简化：不新增状态）

**决策（实现期修订）**：to-agent node_run **复用 `awaiting_human` 状态**，不新增 `awaiting_answer`。

原设计（proposal A12 / 早期 design §2.7）拟新增 `awaiting_answer` 状态。实现时发现 `awaiting_human` 在 scheduler / stuckTaskDetector / workgroupRunner 有 ~20 处触点（bubble、frontier `awaitingHuman` 桶、`loadOpenClarify` 收集），新增 `awaiting_answer` 会触发全量触点扩散 + s12 status-bucket-universe 审计锁翻红，而 `awaiting_human` 天然覆盖语义（"等答案"，无论答者是人还是 agent A）：

- to-agent node_run mint 时 status=`awaiting_human`（复用 `park-human` 事件）。
- A 吐 `<workflow-clarify-answer>` -> to-agent 转 `done`（复用 `resume-clarify` 事件）。
- A 升级问人 -> A 的 self-clarify 也 `awaiting_human`，to-agent 保持 `awaiting_human`；task 整体 park 语义统一。
- scheduler frontier 的 `awaitingHuman` 桶天然包含 to-agent（零改 `loadOpenClarify` / `deriveFrontier`）。
- UI 区分靠节点 kind（`clarify-to-agent` vs `clarify`），不靠状态值。

**代价**：`awaiting_human` 在 to-agent 场景字面是"等 agent 答"而非"等人答"，但语义抽象一致（都是等某种答案回填），且 proposal A12 的状态区分用 chip + 节点 kind 已足够。这是面向代码最合理的简化（记忆 `prefer-correct-over-minimal`）。

**lifecycle 转移零新增**：`park-human`（pending|running -> awaiting_human）+ `resume-clarify`（awaiting_human -> done）已存在，to-agent 直接复用。`mark-failed` / `cancel-by-supersede` 的 awaiting_* 列表无需扩展（已含 awaiting_human）。

### 2.8 rerun cause 扩展

`packages/backend/src/services/clarifyRerunLedger.ts`（`:28-34`）+ `nodeRunMint.ts`（`:261-262` `isClarifyRerunCause`）新增：

```ts
// A 重跑回答 B 的反问 (isClarifyRerun=TRUE, 可 inline resume)
'clarify-to-agent-answer'
// B 重跑带 A 的回答 (isClarifyRerun=TRUE, 可 inline resume)
'clarify-to-agent-questioner-rerun'
```

`RERUN_CAUSES` 常量 + gates 表（`scheduler.ts` gates-2 表锁）同步登记。

## 3. 运行时（scheduler + service）

新建 `packages/backend/src/services/toAgentClarify.ts`，结构与 `crossClarify.ts` 对称。

### 3.1 B 提问 -> to-agent park -> A 重跑

`scheduler.ts` 的 clarify dispatch 入口（当前 `:3422-3513` 处理 B 跑完吐 `<workflow-clarify>`），扩展三分流：

```ts
// scheduler.ts (B 跑完, lastResult.clarify !== undefined):
const crossNode = findCrossClarifyNodeForQuestioner(definition, node.id)   // 既有 :3434
const toAgentNode = findToAgentNodeForQuestioner(definition, node.id)       // <-- 新增

if (toAgentNode) {
  // B 的 __clarify__ 指向 to-agent 节点 -> 走 to-agent 路径
  return await createToAgentSessionAndTriggerAnswerer(state, { questionerB: node, toAgentNode, clarify: lastResult.clarify })
}
if (crossNode) { /* 既有 cross 路径 */ }
// 否则 self-clarify 路径
```

`createToAgentSessionAndTriggerAnswerer`（`toAgentClarify.ts`）：

1. 解析 `to_agent.to_answerer` 边找到 A（answererNodeId）。找不到 -> `clarify-to-agent-answerer-missing-at-runtime` fail B 的 node_run。
2. **多源汇总屏障**（对齐 RFC-056 `evaluateDesignerRerunReadiness`，`crossClarify.ts:339-416`）：收集所有指向同一 A 的 to-agent 节点的 latest session，检查是否都已 resolve（answered/abandoned）或本批将一起触发。**只有当 A 当前没有正在跑的 answer run 时才触发 A 重跑**，避免 A 被连续触发多次。多个 to-agent 待答时，A 一次重跑 prompt 含所有问题（按 nodeId 字典序拼 `## Clarify Request` 子段，见 §3.4）。
3. mint to-agent node_run（status=`awaiting_human`，cause=`to-agent-park`）。
4. 插入 `clarify_rounds`（kind=`'to-agent'`，`askingNodeId`=B，`intermediaryNodeId`=to-agent，`answererNodeId`=A，`status`=`awaiting_human`，`questionsJson`=B 的 questions，`answersJson`=NULL）。
5. 广播 `clarify-to-agent.created` WS。
6. **触发 A 重跑**（cause=`clarify-to-agent-answer`）：roll back 到 A 的 `pre_snapshot`（对齐 RFC-023 `triggerAgentRerunFromClarify`，`clarify.ts` triggerAgentRerunFromClarify；**不 roll back worktree 若 A 需保留草稿**--design 决策：A 回答重跑 roll back，与 self-clarify 一致，A 的产出通过 `## Prior Output` block 注入对齐 RFC-056 patch 2026-06-22）。
7. A 重跑 prompt 注入 `## Clarify Request` block（§6）+ 协议指令。
8. 返回 `{ kind: 'awaiting_human' }`，scheduler 据此不推进 B 的下游。

### 3.2 A 回答 -> 回流 B

A 重跑完，`runner.ts` envelope 解析（当前 `:1200-1234` 解析 `<workflow-clarify>`）扩展：

```ts
// runner.ts envelope 解析新增分支:
if (tag === 'workflow-clarify-answer') {
  const parsed = ClarifyAnswerEnvelopeSchema.safeParse(JSON.parse(body))
  if (!parsed.success) return { errCode: 'clarify-to-agent-answer-malformed' }
  result.clarifyAnswer = parsed.data  // { markdown }
}
```

**互斥校验**（reuse RFC-023 `clarify-and-output-both-present` 逻辑）：
- A 同回复同时含 `<workflow-output>` + `<workflow-clarify-answer>` -> fail `clarify-to-agent-answer-and-output-both-present`。
- A 同回复同时含 `<workflow-clarify-answer>` + `<workflow-clarify>` -> fail `clarify-to-agent-answer-and-clarify-both-present`（proposal A5）。
- A 同回复只含 `<workflow-output>`（既不答也不问）-> 检测 to-agent session 仍 `awaiting_human` -> fail `clarify-to-agent-timeout-no-answer`（proposal A6）。

scheduler 检测 `lastResult.clarifyAnswer !== undefined`：

```ts
// A 跑完吐 answer:
if (lastResult.clarifyAnswer) {
  return await commitToAgentAnswerAndTriggerQuestioner(state, { answererA: node, answer: lastResult.clarifyAnswer })
}
```

`commitToAgentAnswerAndTriggerQuestioner`（`toAgentClarify.ts`）：

1. 找到 A 本次回答对应的 to-agent session（按 answererNodeId=A + awaiting_human + 本次 A run 关联）。**多源**：若 A 一次回答覆盖多个 to-agent session，按回答内容拆分或统一注入（v1：A 一次 answer envelope 回答所有指向它的 awaiting to-agent session，markdown 整体注入每个 B 的 flat block；per-question 拆分留后续延展）。
2. 更新 `clarify_rounds`：`answersJson`=answer.markdown，`status`=`answered`，`answererNodeRunId`=A run id，`answeredAt`=now。
3. to-agent node_run -> `answered`（lifecycle 转移）。
4. 广播 `clarify-to-agent.answered` WS。
5. **触发 B 重跑**（cause=`clarify-to-agent-questioner-rerun`）：roll back 到 B 的 `pre_snapshot`，mint 新 B node_run，B 的 prompt 注入 A 的回答（flat `## Clarify Q&A` block 作 peer entry，§6.3）。
6. B 重跑继续。

### 3.3 A 升级问人

A 重跑吐 `<workflow-clarify>`（而非 answer）：

1. scheduler 检测 A 的 `__clarify__` 出边。**若 A 挂了 self-clarify 节点**（A.`__clarify__` -> self-clarify），走 RFC-023 self-clarify 路径（既有 `:3469-3512`）：mint A 的 self-clarify session（kind=`'self'`，`askingNodeId`=A），A 的 self-clarify node_run `awaiting_human`，task 顶层 `awaiting_human`。
2. **to-agent session 保持 `awaiting_human`**（A 还没答 B，只是先问人）。广播 `clarify-to-agent.escalated` WS。
3. 人答 A（`POST /api/clarify/:A的self-clarify nodeRunId/answers`，既有路由）-> A 带 self-clarify 答案重跑（cause=`clarify-answer`，RFC-023 既有）-> A 这次清楚吐 `<workflow-clarify-answer>` -> 走 §3.2 回流 B。

**关键**：A 升级问人期间，to-agent session 不变（`awaiting_human`），scheduler 的 `loadOpenClarify`（`scheduler.ts:1238-1271`）扩展收集 to-agent `awaiting_human` session 作为 frontier 证据，阻止 task 误判完成。

### 3.4 多源汇总

多个 to-agent 指向同一 A（proposal S7）：

- B1、B2 各自反问 -> 两个 to-agent session `awaiting_human`。
- `createToAgentSessionAndTriggerAnswerer` 的多源屏障（§3.1.2）：A 当前无正在跑的 answer run -> 触发**一次** A 重跑，prompt 的 `## Clarify Request` 段含两个 source 子段（按 to-agent nodeId 字典序，每段冠以 `### From '{questionerNodeId}'`）。
- A 一次 `<workflow-clarify-answer>` 回答 -> `commitToAgentAnswerAndTriggerQuestioner` 把回答注入每个 to-agent session（markdown 整体），两个 B 各自重跑。
- 若 A 升级问人，A 的 self-clarify 一次问人覆盖所有 source 的问题（self-clarify 既有逻辑）。

### 3.5 wrapper-loop 内

- to-agent 节点 `loopMembership`（既有 `workflow.validator.ts` loop 成员判定）参与 `clarify-to-agent-no-iteration-cap`。
- `clarify_rounds` 的 `loopIter` 字段（既有，`:1544` 附近）隔离每轮 loop 的 to-agent session。
- A 升级问人的 reject / STOP 持久性沿用 RFC-023 cross-iter 语义（A 的 self-clarify 通道不变）。
- `to_agent_iteration` 每 loop_iter 从 0 重新计（对齐 RFC-056 `cross_clarify_iteration`）。

### 3.6 scheduler frontier 判定

`loadOpenClarify`（`scheduler.ts:1238-1271`）扩展：

```ts
// 既有: 收集 awaiting_human 的 self/cross session
// 新增: 收集 awaiting_human 的 to-agent session (answerer A 未吐回答前, task 不算完成)
const toAgentSessions = await db.select({ ... }).from(clarifyRounds)
  .where(and(eq(clarifyRounds.kind, 'to-agent'), eq(clarifyRounds.status, 'awaiting_human')))
toAgentSessions.forEach(s => clarifyNodeIds.add(s.intermediaryNodeId))
```

`scheduler.ts:1605-1614` 的 completed 判定：`awaiting_human` 不入 `completed`（对齐 `awaiting_human` 处理，`:1606-1614` 既有 isNodeRunFresh + mergeState 门 + 不含 awaiting_*）。

## 4. envelope 解析细节

`packages/backend/src/services/runner.ts`（envelope 解析入口 `:1200-1234`）：

```ts
// 既有: <workflow-clarify> (kind 区分 self/cross)
// 新增: <workflow-clarify-answer>
const CLARIFY_ANSWER_ENVELOPE_TAG = 'workflow-clarify-answer'

// 解析顺序: 一条 stdout 里 last envelope wins (既有规则)
// 但 to-agent 路径强制互斥: answer / clarify / output 三选一
```

**互斥校验时机**：runner 解析完所有 envelope 后，在 to-agent answerer run 的上下文里校验：
- 若 A 是 to-agent answerer（其 `__clarify_request__` 有入边）且本次 run 关联 awaiting_human session：
  - 有 `clarifyAnswer` + 有 `output` -> fail `clarify-to-agent-answer-and-output-both-present`
  - 有 `clarifyAnswer` + 有 `clarify` -> fail `clarify-to-agent-answer-and-clarify-both-present`
  - 无 `clarifyAnswer` + 无 `clarify` + 有 `output` -> fail `clarify-to-agent-timeout-no-answer`
  - 有 `clarifyAnswer`（且无其他）-> 走 §3.2 回流
  - 有 `clarify`（且无其他）-> 走 §3.3 升级问人

**A 不是 to-agent answerer 时**（A 的 `__clarify_request__` 无入边）：互斥校验不触发，A 行为零差异（A 可正常产 output + 挂 self-clarify 问人，RFC-023 既有）。

## 5. validator 规则

`packages/backend/src/services/workflow.validator.ts`，新增 §4e 段（与 §4d cross-clarify `:1049-1251` 并列）：

| code | severity | 触发条件 |
| --- | --- | --- |
| `clarify-to-agent-input-source-missing` | error | `questions` 无入边或引用不存在节点 |
| `clarify-to-agent-target-not-agent-single` | error | `questions` 入边源不是 agent-single |
| `clarify-to-agent-has-downstream` | error | 有非 `to_answerer`/`to_questioner` 的 outgoing 边 |
| `clarify-to-agent-answerer-edge-missing` | warning | `to_answerer` 未连 |
| `clarify-to-agent-answerer-not-ancestor` | warning | A 不是 B 的拓扑上游祖先 |
| `clarify-to-agent-answerer-self` | warning | A === B 同 agent 定义 |
| `clarify-to-agent-no-iteration-cap` | warning | 不在 wrapper-loop 内 |
| `clarify-to-agent-multiple-answerers` | error | `to_answerer` 连向 ≥2 agent |

**系统端口边完整性**（§4d-bis `:1253-1414` 扩展）：
- `__clarify_request__` 的源必须是 to-agent 的 `to_answerer`（`system-port-illegal-source` 扩展）。
- `to_answerer` 的目标必须是 agent-single（`system-port-illegal-target` 扩展）。

**multiplicity 预检**（RFC-069 `:1717-1791` `validateAgentClarifyMultiplicity` 扩展）：
- 新增 `clarify-to-agent-multiple-on-answerer`：A 的 `__clarify_request__` 被 ≥2 个 to-agent 指向 -> error（一个 agent 不能同时被多个 to-agent 反问，回答归属歧义；多 B 反问同一 A 走 §3.4 多源汇总而非多 to-agent 指向同一 A 的 `__clarify_request__`——**修正**：多源汇总是多个 to-agent 节点指向同一 A，但 A 的 `__clarify_request__` 是单一系统端口，多个 to-agent 的 `to_answerer` 边都指向 A 的 `__clarify_request__`。validator 允许多 `to_answerer` -> 同一 A（多源汇总），但 `clarify-to-agent-multiple-answerers` fail 是单个 to-agent 的 `to_answerer` 连向 ≥2 不同 A。两个规则正交：单 to-agent -> 单 A（多 to-agent -> 同 A 允许，走多源汇总）。

**拓扑环豁免**（`:427-459`）：to-agent 的反馈环（B.`__clarify__` -> to-agent -> B.`__clarify_response__` -> B 重跑）与 clarify/cross-clarify 同属有意设计的环，DAG 检查跳过触及 `clarify-to-agent` 节点的边（`:451`/`:457` 附近扩展加 `clarify-to-agent`）。`isClarifyChannelEdge`（`clarify.ts:581`）扩展识别 to-agent 通道边。

## 6. prompt 注入

### 6.1 A 侧：`## Clarify Request` block（auto-append only）

**决策（实现期修订）**：**不引入新 `{{__clarify_request__}}` 等 builtin token**，A 侧注入纯走 auto-append。原设计（早期 design §6.1）拟加 3 个 token，实现时发现 RFC-132/148 已把所有 clarify 注入统一成无 token 的 flat block（`__clarify_questions__` 等已在 `DEPRECATED_PROMPT_TOKENS`），加 token 与该哲学相悖且增加 `BUILTIN_VARS` + validator `prompt-template-unresolved` 维护面。

机制：A 是 to-agent answerer 重跑时（cause=`clarify-to-agent-answer`），scheduler 组装 `ClarifyRequestSource[]`（B 的问题列表 + questionerNodeId），调 `buildClarifyRequestBlock`（T3 已实现，`shared/clarify.ts`）渲染成 `## Clarify Request` markdown 段，在 `renderUserPrompt` 末尾 auto-append（对齐 RFC-023 `## Clarify Q&A` auto-append + `prompt.ts:461` `PROMPT_INJECTED_PORT_NAMES`：`__clarify_request__` 已在该 skip 集合，故不再为空端口头 auto-append）。

```ts
// scheduler 组装 + 注入（T13 wire）：
const block = buildClarifyRequestBlock(sources)  // sources 已按 questionerNodeId 字典序排
if (block !== undefined) {
  // append to A's user prompt (mirrors flat Clarify Q&A auto-append path)
}
```

`buildClarifyRequestBlock` 是纯函数（T3 已测），输入 `ClarifyRequestSource[]`，输出含问题清单 + `<workflow-clarify-answer>` 协议指令的 markdown 段。空 sources -> undefined（不注入）。

### 6.2 A 侧：self-clarify 通道独立

A 同时挂 self-clarify 时，A 的 self-clarify 重跑（cause=`clarify-answer`）走 RFC-023 flat `## Clarify Q&A` block（与人答 Q&A 同面），与本 RFC `## Clarify Request` block 独立（两段并存，对齐 RFC-056 designer self+cross 共存设计，proposal A12/S12 同构）。两套 rerun cause 独立（`clarify-answer` vs `clarify-to-agent-answer`），不互污染。

### 6.3 B 侧：flat `## Clarify Q&A` block（复用）

B 重跑带回答（cause=`clarify-to-agent-questioner-rerun`）时，`buildClarifyQueueContext`（`clarifyQueue.ts` `selectAgentQueue`）扩展：选出 B 的 to-agent answered session，A 的回答 markdown 作为 `FlatClarifyEntry`（`clarify.ts:419-425`）进 flat `## Clarify Q&A` block，与人答 Q&A 同等 peer 渲染。

**FlatClarifyEntry 不加字段**（v1）：A 回答与人答 Q&A 同形。`selectAgentQueue` 按 `clarify_rounds` 的 kind=`'to-agent'` + status=`answered` 选 entry，markdown 直接作 entry body。

### 6.4 协议块顺序

A 重跑（answerer）prompt 段顺序：
1. agent 原始 promptTemplate（用户的 `{{...}}` 替换）
2. `## Prior Output`（A 上轮产出，对齐 RFC-056 patch）
3. `## Clarify Request`（本 RFC，B 的问题 + 协议指令）
4. 协议块（`<workflow-output>` / `<workflow-clarify>` / `<workflow-clarify-answer>` 输出指令，`buildProtocolBlock` 扩展）

B 重跑 prompt 段顺序：
1. agent 原始 promptTemplate
2. `## Clarify Q&A`（flat block，含 A 回答作 peer entry）
3. 协议块

## 7. 失败模式

| 失败码 | 触发 | 处理 |
| --- | --- | --- |
| `clarify-to-agent-answerer-missing-at-runtime` | `to_answerer` 目标运行时找不到 | fail B node_run + retries |
| `clarify-to-agent-answer-malformed` | A 吐的 answer body 不合法 JSON / 缺 markdown | fail A node_run + retries |
| `clarify-to-agent-answer-and-output-both-present` | A 同回复 answer + output | fail A + retries |
| `clarify-to-agent-answer-and-clarify-both-present` | A 同回复 answer + clarify | fail A + retries |
| `clarify-to-agent-timeout-no-answer` | A 只吐 output 不答不问 | fail A + retries |
| `clarify-and-output-both-present` (reuse) | A 的 self-clarify 路径互斥 | reuse RFC-023 |
| `inline-clarify-to-agent-fallback-to-isolated` | inline 模式缺 sessionId / session-not-found | 退 isolated + warning, task 不 fail |
| `clarify-to-agent-abandoned` | A fail / task fail 时 awaiting_human session 升级 abandoned | invariant 扫描 + UI chip |

**RFC-053 invariant**（新建 `tests/clarify-to-agent-abandoned-invariant.test.ts`）：daemon 启动 + 每小时扫 `clarify_rounds` kind=`'to-agent'` status=`awaiting_human`，若 answerer node_run 已终态（failed/canceled）-> 升级 session `abandoned`。

## 8. 测试策略

### 8.1 首选可断言面（纯函数 / 纯数据预言）

- `buildToAgentAutoEdges`（§2.4）：纯函数，2 条边形态断言。
- `ClarifyAnswerEnvelopeSchema`（§2.5）：纯 schema，happy / malformed / 缺 markdown case。
- `buildClarifyRequestBlock`（§6.1）：纯函数，单源 / 多源 / 空 questions 边界。
- lifecycle 转移矩阵（§2.7）：`awaiting_human` 全笛卡尔积合法/非法转移。
- `isClarifyRerunCause`（§2.8）：新 cause 映射 TRUE/FALSE。

### 8.2 集成断言

- `toAgentClarify.ts` service：createToAgentSession / commitAnswer / escalate / 多源汇总 / abandoned 升级。
- scheduler：B 提问 dispatch / A 回答 dispatch / A 升级 bubble / frontier 不误推。
- runner envelope 解析：answer / clarify / output 互斥矩阵。
- validator：9 规则 + multiplicity + 系统端口完整性。

### 8.3 源代码层文本断言（兜底）

- `packages/shared/src/prompt.ts` grep `{{__clarify_request__}}` / `{{__clarify_request_iteration__}}` / `{{__clarify_request_questioner__}}`（C2）。
- `packages/shared/src/clarify.ts` grep `## Clarify Request` auto-append 文案。
- `clarify-to-agent` NodeKind 不得在 `WorkflowCanvas.tsx` 出现裸字符串（走公共节点组件）。

### 8.4 测试文件清单（≥ +35 backend）

| 文件 | case | 覆盖 |
| --- | --- | --- |
| `tests/clarify-to-agent-envelope.test.ts` | 6 | answer schema happy/malformed + 互斥 3 + timeout-no-answer |
| `tests/clarify-to-agent-prompt-injection.test.ts` | 5 | `## Clarify Request` 单源/多源 + 3 token grep + auto-append |
| `tests/clarify-to-agent-service.test.ts` | 8 | createSession / commitAnswer / escalate / 多源 / abandoned / answerer-missing / iteration / loop_iter 隔离 |
| `tests/clarify-to-agent-scheduler.test.ts` | 6 | B dispatch / A dispatch / bubble / frontier 不误推 / 多源汇总 / loop max_iter |
| `tests/clarify-to-agent-lifecycle.test.ts` | 5 | awaiting_human 转移矩阵 + s14 守卫 + invariant |
| `tests/clarify-to-agent-validator-rules.test.ts` | 9 | 9 规则覆盖 |
| `tests/clarify-to-agent-inline-fallback.test.ts` | 3 | inline happy / 缺 sessionId / session-not-found |

frontend（≥ +12）：canvas drag 3 / Inspector 3 / 节点渲染 2 / 看板 chip 2 / flat block 注入 2。

### 8.5 e2e

`e2e/clarify-to-agent.spec.ts`：fixture stub-opencode，A->B + to-agent，A 产 `<workflow-clarify-answer>`，B 带回答产出 output -> task done（覆盖 A1）。

## 9. 与现有模块的耦合点（实现时核对）

| 模块 | 改动类型 | 风险 |
| --- | --- | --- |
| `shared/schemas/workflow.ts` NodeKind 联合 | 追加值 | 低（追加，不改既有） |
| `shared/nodePorts.ts` agent-single systemInputs | 追加端口 | 中（影响所有 agent-single 端口计算，需确认既有 caller 容忍新端口） |
| `shared/clarify.ts` buildToAgentAutoEdges + isClarifyChannelEdge | 新增函数 + 扩展 | 低 |
| `shared/prompt.ts` renderUserPrompt | 追加 `## Clarify Request` auto-append 分支（无新 token） | 低 |
| `shared/lifecycle.ts` awaiting_human | 新增状态 + 转移 | 中（s14 守卫 / SETTLED 集合） |
| `backend/services/runner.ts` envelope 解析 | 新增 tag 分支 | 低 |
| `backend/services/scheduler.ts` clarify dispatch | 新增三分流 | 中（既有 self/cross 分流不动，新分流在前） |
| `backend/services/workflow.validator.ts` §4e + multiplicity | 新增段 + 扩展 | 低 |
| `backend/services/clarifyQueue.ts` selectAgentQueue | 扩展选 to-agent entry | 低（追加 kind 分支） |
| `backend/services/clarifyRerunLedger.ts` + nodeRunMint.ts | 新增 cause | 低 |
| `backend/db/schema.ts` clarify_rounds + node_runs | 加列 + CHECK | 低（forward migration） |
| `frontend` 节点 + inspector + 看板 | 新增组件 | 低 |

**strict diff guard**（B2）：`packages/shared/src/clarify.ts` 既有 export 字节级不变（新增 export 不算违反）；`packages/backend/src/services/crossClarify.ts` diff = 0（本 RFC 不改 cross-clarify）；`packages/backend/src/services/clarify.ts` 仅新增 to-agent 调用入口，既有 self-clarify 函数字节不变。

## 10. 实现顺序建议（plan.md 细化）

1. shared 层：NodeKind + 端口常量 + nodePorts + buildToAgentAutoEdges + envelope schema + `buildClarifyRequestBlock`（lifecycle 复用 `awaiting_human`，不新增状态/token，见 §2.7 / §6.1）。
2. backend DB：migration + schema.ts。
3. backend service：`toAgentClarify.ts`。
4. backend runner：envelope 解析 + 互斥校验。
5. backend scheduler：dispatch 三分流 + frontier + loadOpenClarify 扩展。
6. backend validator：§4e + multiplicity + 系统端口完整性 + 环豁免。
7. backend prompt 注入：`## Clarify Request` block + flat block 选 to-agent entry。
8. backend rerun cause + lifecycle 转移 + invariant。
9. frontend：节点 + inspector + 看板 chip + WS。
10. 测试 + e2e + 门禁。

每步带测试，`bun run typecheck && bun run test && bun run format:check` 全绿才推。
