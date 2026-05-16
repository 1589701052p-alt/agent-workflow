# RFC-023 Design — 反问澄清节点（Clarify）技术设计

> 关联：[proposal.md](./proposal.md)、[plan.md](./plan.md)

## 1. 改动地图

| 文件 | 改动类型 | 摘要 |
| --- | --- | --- |
| `packages/shared/src/schemas/workflow.ts` | edit | `NODE_KIND` 加 `'clarify'`；`WORKFLOW_SCHEMA_VERSION` `2 → 3`（v1 / v2 仍 readable）；新 `ClarifyNodeSchema`；`ClarifySystemPortsSchema` 描述 agent 节点上由反向拖动注入的两个系统级 port `__clarify__` / `__clarify_response__`（非端口列表的一部分，仅 edges 引用） |
| `packages/shared/src/schemas/agent.ts` | edit (minimal) | **不动** `outputs` 字段；新增 `hasClarifyChannel` derived helper（纯函数，无 schema 增减）：根据 workflow.definition.edges 判断该 agent 节点是否被 clarify 链接 |
| `packages/shared/src/schemas/task.ts` | edit | `tasks.status` 枚举加 `'awaiting_human'`；`node_runs.status` 同步加 |
| `packages/shared/src/schemas/clarify.ts` | new | `ClarifyQuestionSchema` / `ClarifyEnvelopeBodySchema`（JSON shape）/ `ClarifyAnswerSchema` / `ClarifySessionSchema` / List / Create / SubmitAnswers payload |
| `packages/shared/src/schemas/ws.ts` | edit | 新 events `clarify.created` / `clarify.answered` |
| `packages/shared/src/prompt.ts` | edit | `BUILTIN_VARS` 加 4 个 `__clarify_*__` token；`ReviewPromptContext` 平级新增 `ClarifyPromptContext`（不复用同对象，两者可同时存在但绝大多数 case 互斥）；`renderUserPrompt` 加 4 case + auto-append `## Clarify Q&A` 段 |
| `packages/shared/src/clarify.ts` | new | 纯函数：`buildClarifyPromptBlock(questions, answers, opts)` / `summariseClarifyAnswer(question, answer)` / `parseClarifyEnvelopeBody(jsonStr)`（zod + 形态宽容截断）/ `renderClarifyQuestionsBlock(questions)` |
| `packages/backend/src/db/schema.ts` | edit | (a) `tasks.status` / `node_runs.status` enum 加 awaiting_human；(b) `node_runs` 加 `clarify_iteration INTEGER NOT NULL DEFAULT 0`；(c) 新表 `clarify_sessions`（设计见 §3） |
| `packages/backend/db/migrations/0007_*.sql` | new | `drizzle-kit generate` 产物（接 RFC-017 0005 之后） |
| `packages/backend/src/services/clarify.ts` | new | 全部反问业务逻辑：`createClarifySession` / `submitClarifyAnswers` / `triggerAgentRerunFromClarify` / `cleanupSessionsForTask` / 注入 prompt 上下文 |
| `packages/backend/src/services/envelope.ts` | edit | 新 helper `detectEnvelopeKind(stdout)` 返回 `'output' \| 'clarify' \| 'both' \| 'none'`；`extractClarifyEnvelopeBody(stdout)` 复用 `extractLastEnvelope` 模式 |
| `packages/backend/src/services/runner.ts` | edit | 节点完成时根据 envelope kind 分支：clarify → 暂不写 outputs 而是调 `clarify.createClarifySession`；标该 agent node_run 状态 `done` 但产物记 `clarify_session_id`；clarify 节点的 node_run 状态 `awaiting_human` |
| `packages/backend/src/services/scheduler.ts` | edit | (a) 调度判 ready：clarify 节点 ready = 上游 agent 出了 clarify envelope；(b) `awaiting_human` task 不占并发；(c) `submitClarifyAnswers` 后重新激活 agent 节点（新 node_run, clarify_iteration+1, retry_index=0）+ 回滚 pre_snapshot；(d) `recomputeTaskStatus` 加 awaiting_human 分支（优先级高于 awaiting_review）；(e) agent-multi 父节点的 aggregate 判定：所有 shard 子 done **且** 该父节点下没有任何 awaiting_human 的 clarify_session |
| `packages/backend/src/services/protocol.ts` | unchanged | 已是 re-export of shared，不动 |
| `packages/backend/src/services/workflow.validator.ts` | edit | 新规则（见 §6）；`agent-multi` 上游连 clarify 拒绝；`clarify-no-iteration-cap` warning |
| `packages/backend/src/routes/clarify.ts` | new | REST：`GET /api/clarify`（filter by task / status） / `GET /api/clarify/:nodeRunId` / `POST /api/clarify/:nodeRunId/answers` / `GET /api/clarify/pending-count`（左栏 badge 用） |
| `packages/backend/src/routes/ws.ts`（或现有 ws 文件） | edit | 加 clarify.* broadcast 到 TaskWsMessageSchema（与 review 同 channel `/ws/tasks/{taskId}`） |
| `packages/backend/src/services/exitCondition.ts` | edit (small) | `port-empty` 退出条件已存在；clarify 节点 + agent 输出 `<workflow-output>`（非 clarify）时 `__clarify__` 系统 port 该轮无产数据，自然命中 port-empty。**仅在 sanity 测试中确认**，零代码改动 |
| `packages/frontend/src/components/canvas/nodePalette.ts` | edit | palette "Human" 分类下加 clarify 节点条目 |
| `packages/frontend/src/components/canvas/nodes/ClarifyNode.tsx` | new | xyflow 节点视觉：4 态色块（pending=灰、awaiting_human=黄、answered=绿、failed=红）；端口图标固定 1 进 1 出；header pill 显示 "反问澄清" |
| `packages/frontend/src/components/canvas/clarifyDragHelper.ts` | new | 纯函数：`shouldRegisterClarifySystemPorts(sourceNode, targetNode)` / `buildClarifyEdges(sourceNodeId, clarifyNodeId)`；返回两条 edge 的对象，供 WorkflowCanvas.handleConnect 调用 |
| `packages/frontend/src/components/canvas/WorkflowCanvas.tsx` | edit | `handleConnect` 反向拖动分支扩展（review/output drag 已在 RFC-007 落地）：检测 `target.kind==='clarify'` 且 reverse drop → 调 `clarifyDragHelper.buildClarifyEdges` + 加两条 edge；`isValidConnection` 拒 agent-multi → clarify |
| `packages/frontend/src/components/canvas/NodeInspector.tsx` | edit | 加 `clarify` 分支：仅展示只读字段（title / description）+ "已挂接到 agent: `{agentNodeId}`" + warning when not in loop；端口不可编辑 |
| `packages/frontend/src/routes/clarify.tsx` | new | 左栏 Clarify tab 路由：list + segmented filter "待回答 / 已回答 / 全部" + 按 task 分组 |
| `packages/frontend/src/routes/clarify.detail.tsx` | new | `/clarify/:nodeRunId` 详情页：问题列表 + 单选 / 多选表单 + 提交按钮 + draft 自动保存 |
| `packages/frontend/src/components/clarify/QuestionForm.tsx` | new | 单题渲染（radio + textarea / checkbox + textarea） + 数字键 1-5 hotkeys |
| `packages/frontend/src/components/clarify/RecommendedChip.tsx` | new | "推荐" chip 视觉 |
| `packages/frontend/src/lib/clarify/draftStore.ts` | new | IndexedDB 草稿持久化（key = `${taskId}:${clarifyNodeRunId}:${sessionId}`），与 review draftStore 同套 idb-keyval 包装；选择不直接 import review/draftStore 是为了 RFC 物理隔离 + 后续两个 store 演化路径独立 |
| `packages/frontend/src/hooks/useClarifyWs.ts` | new | WS 订阅 + 自动重连 + invalidate query；与 RFC-005 `useReviewWs` 同款样板 |
| `packages/frontend/src/routes/__root.tsx` | edit | 左栏 nav 加 Clarify 项 + pending-count badge |
| `packages/frontend/src/i18n/zh-CN.ts` + `en-US.ts` | edit | 新增 `clarify.*` section 约 30 条 key |
| `design/design.md` | edit | §5 节点类型表加 clarify；§3 数据模型加 clarify_sessions 表 + clarify_iteration 字段；§9 节点状态机加 awaiting_human；§7.4 envelope 解析加 clarify 分支；§4.3 WS 频道加 clarify.* events |
| `STATE.md` | edit | 顶部追加"进行中 RFC：[RFC-023]…"；完工后挪到"已完成 RFC"表 |
| `design/plan.md` | edit | RFC 索引追加 RFC-023 行（Draft → In Progress → Done） |

明示不动的文件（重点防误改）：

- `packages/backend/src/services/review.ts` 一行不动。
- `packages/backend/src/services/agent.ts` CRUD 路径一行不动（agent outputs schema 不变）。
- `packages/shared/src/schemas/agent.ts` 字段不动（不加 hasClarifyChannel 列；仅作 derived helper 函数）。
- `packages/backend/src/services/scheduler.ts` 中既有 review reject/iterate cascade / multi-process fanout / loop expand 算法不动；仅在 dispatch 表里加 clarify 分支。
- 数据库 0001–0005 既有迁移文件不动。
- RFC-007 review/output reverse-drag 代码（`WorkflowCanvas.handleConnect` 既有 review/output 分支）不动；clarify 分支与之并列。
- RFC-014 sibling cascade 代码不动。

## 2. NodeKind 扩展

```ts
// packages/shared/src/schemas/workflow.ts

export const NODE_KIND = [
  'agent-single',
  'agent-multi',
  'input',
  'output',
  'wrapper-git',
  'wrapper-loop',
  'review',
  'clarify', // NEW (RFC-023)
] as const

export const WORKFLOW_SCHEMA_VERSION = 3 // bump v2 → v3 (v1/v2 仍 GET 期上提)
export const WORKFLOW_SCHEMA_VERSIONS = [1, 2, 3] as const
```

### 2.1 ClarifyNode 形态

```ts
// packages/shared/src/schemas/workflow.ts (附加)

export const ClarifyNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('clarify'),
    position: XYSchema.optional(),

    // 仅 UI 显示用；不参与运行时
    title: z.string().default(''),
    description: z.string().default(''),

    // assignee 预留位（v1 不暴露 UI），与 review 节点对称
    assignee: z.string().optional(),

    // 关键：clarify 节点的 input/output 端口名是**框架硬编码**的（'questions' / 'answers'），
    // 不允许用户改也不出现在 frontmatter outputs 之类的字段。这与 agent 节点完全不同。
  })
  .passthrough()
```

`ClarifyNodeSchema` 不包含 `inputs[]` / `outputs[]`；编辑器侧渲染时**硬编码**两个端口：

```ts
export const CLARIFY_INPUT_PORT_NAME = 'questions' as const
export const CLARIFY_OUTPUT_PORT_NAME = 'answers' as const
```

### 2.2 系统端口约定（agent 节点上由反向拖动注入）

agent 节点的 `outputs[]` 字段不动；当 workflow.definition.edges 中存在一条边 `source = { nodeId: <agent>, portName: '__clarify__' }` 时，框架视为该 agent 节点开启反问通道。`__clarify__` / `__clarify_response__` 不写入 agent 的 frontmatter / DB / agent.outputs，仅作为 workflow.definition 局部的 system port。

`packages/shared/src/clarify.ts` 提供查询助手：

```ts
export const CLARIFY_SOURCE_PORT_NAME = '__clarify__' as const
export const CLARIFY_RESPONSE_TARGET_PORT_NAME = '__clarify_response__' as const

export function agentHasClarifyChannel(
  definition: WorkflowDefinition,
  agentNodeId: string,
): boolean {
  return definition.edges.some(
    (e) => e.source.nodeId === agentNodeId && e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
}

export function findClarifyNodeForAgent(
  definition: WorkflowDefinition,
  agentNodeId: string,
): string | undefined {
  const edge = definition.edges.find(
    (e) => e.source.nodeId === agentNodeId && e.source.portName === CLARIFY_SOURCE_PORT_NAME,
  )
  return edge?.target.nodeId
}
```

### 2.3 Workflow validator 新规则

| code | severity | 触发 |
| --- | --- | --- |
| `clarify-input-source-missing` | error | clarify 节点的 input edge 对端节点不存在 |
| `clarify-target-not-agent` | error | clarify 入边对端节点 kind 不属于 `{agent-single, agent-multi}`（即接到 wrapper / review / output / input / 另一个 clarify 时拒绝） |
| `clarify-self-loop` | error | clarify.answers 出边目标 nodeId === 自身 nodeId |
| `clarify-questions-port-missing` | error | clarify 节点没有入边（孤立节点） |
| `clarify-no-iteration-cap` | warning | clarify 节点不在 wrapper-loop 内 |
| `clarify-answers-port-disconnected` | warning | clarify.answers 没出边（注入路径仍隐式生效，但画布上视觉异常） |
| `clarify-multiple-clarify-on-same-agent` | error | 同一 agent 节点上挂了 ≥ 2 个 clarify 节点 |

注：v1 **允许** agent-multi 上游 → clarify（每 shard 独立反问）。`clarify-target-not-agent` 仅在对端不是 `agent-single` 或 `agent-multi` 时报错。

## 3. DB schema

```ts
// packages/backend/src/db/schema.ts (片段)

export const tasks = sqliteTable('tasks', {
  // ... existing fields ...
  status: text('status', {
    enum: [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'awaiting_review',
      'awaiting_human', // NEW (RFC-023)
    ],
  }).notNull(),
})

export const nodeRuns = sqliteTable('node_runs', {
  // ... existing fields including review_iteration ...
  clarifyIteration: integer('clarify_iteration').notNull().default(0), // NEW (RFC-023)
  status: text('status', {
    enum: [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'skipped',
      'exhausted',
      'awaiting_review',
      'awaiting_human', // NEW (RFC-023)
    ],
  }).notNull(),
})

// -----------------------------------------------------------------------------
// clarify_sessions — one row per agent reply containing <workflow-clarify>.
// -----------------------------------------------------------------------------
export const clarifySessions = sqliteTable(
  'clarify_sessions',
  {
    id: text('id').primaryKey(), // ULID
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    sourceAgentNodeId: text('source_agent_node_id').notNull(), // workflow node id of asking agent
    sourceAgentNodeRunId: text('source_agent_node_run_id').notNull(), // node_runs.id of asking agent run (the one that produced the clarify envelope); for agent-multi this is the shard child node_run id
    sourceShardKey: text('source_shard_key'), // shard_key of the asking node_run when source is an agent-multi shard; NULL for agent-single
    clarifyNodeId: text('clarify_node_id').notNull(), // workflow node id of the clarify node
    clarifyNodeRunId: text('clarify_node_run_id').notNull(), // node_runs.id of the clarify node instance: for agent-multi we mint one clarify node_run PER shard (different sourceShardKey → different clarifyNodeRunId); UI groups them under the same clarifyNodeId
    iterationIndex: integer('iteration_index').notNull(), // matches the source agent node_run's clarify_iteration AT TIME OF ASKING
    questionsJson: text('questions_json').notNull(), // JSON: ClarifyQuestion[]
    answersJson: text('answers_json'), // JSON: ClarifyAnswer[]; NULL until submitted
    status: text('status', {
      enum: ['awaiting_human', 'answered', 'canceled'],
    })
      .notNull()
      .default('awaiting_human'),
    truncationWarningsJson: text('truncation_warnings_json'), // JSON: { code, detail }[]; recorded when agent over-emits questions/options
    createdAt: integer('created_at')
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    answeredAt: integer('answered_at'),
    answeredBy: text('answered_by'), // 'local' always in v1; reserved
  },
  (t) => ({
    taskIdx: index('idx_clarify_sessions_task').on(t.taskId),
    clarifyRunIdx: index('idx_clarify_sessions_clarify_run').on(t.clarifyNodeRunId, t.iterationIndex),
    sourceRunIdx: index('idx_clarify_sessions_source_run').on(t.sourceAgentNodeRunId),
    nodeShardIdx: index('idx_clarify_sessions_node_shard').on(t.clarifyNodeId, t.sourceShardKey),
  }),
)
```

agent-multi fan-out 下 clarify node_runs 的 `parent_node_run_id` 字段（既有 multi-process 路径已有）指向 multi 父节点的 node_run，使 task 详情画布能正确按"父 clarify 节点 → N 个 shard awaiting 子 node_run"层级展示。`source_shard_key` 同步落到 `clarify_sessions` 行用于 UI 分组排序（同一 task / 同一 clarifyNodeId 内按字典序）。

Migration `0007_*.sql` 用 drizzle-kit 标准 enum-rebuild 模板（`__new_node_runs__` + `INSERT INTO __new__ SELECT ... 0 AS clarify_iteration FROM old`），事务内完成。down migration 保留 drizzle 默认生成。

## 4. Shared schemas / 纯函数

### 4.1 `packages/shared/src/schemas/clarify.ts`

```ts
import { z } from 'zod'

export const ClarifyQuestionKindSchema = z.enum(['single', 'multi'])
export type ClarifyQuestionKind = z.infer<typeof ClarifyQuestionKindSchema>

export const ClarifyQuestionSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(512),
  kind: ClarifyQuestionKindSchema,
  recommended: z.boolean().default(false),
  options: z.array(z.string().min(1).max(256)).min(2).max(4),
})
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>

/** What `<workflow-clarify>` body JSON.parse must yield. */
export const ClarifyEnvelopeBodySchema = z.object({
  questions: z.array(ClarifyQuestionSchema).min(1).max(5),
})
export type ClarifyEnvelopeBody = z.infer<typeof ClarifyEnvelopeBodySchema>

/** One user answer for one question. */
export const ClarifyAnswerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionIndices: z.array(z.number().int().nonnegative()).default([]),
  selectedOptionLabels: z.array(z.string()).default([]), // server-side filled, mirrors indices
  customText: z.string().max(2000).default(''),
})
export type ClarifyAnswer = z.infer<typeof ClarifyAnswerSchema>

export const SubmitClarifyAnswersSchema = z.object({
  answers: z.array(ClarifyAnswerSchema),
  ifMatchIteration: z.number().int().nonnegative().optional(), // optimistic lock
})
export type SubmitClarifyAnswers = z.infer<typeof SubmitClarifyAnswersSchema>

export const ClarifySessionSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  sourceAgentNodeId: z.string(),
  sourceAgentNodeRunId: z.string(),
  clarifyNodeId: z.string(),
  clarifyNodeRunId: z.string(),
  iterationIndex: z.number().int().nonnegative(),
  questions: z.array(ClarifyQuestionSchema),
  answers: z.array(ClarifyAnswerSchema).optional(),
  status: z.enum(['awaiting_human', 'answered', 'canceled']),
  truncationWarnings: z
    .array(
      z.object({
        code: z.string(),
        detail: z.string(),
      }),
    )
    .optional(),
  createdAt: z.number().int(),
  answeredAt: z.number().int().optional(),
})
export type ClarifySession = z.infer<typeof ClarifySessionSchema>
```

### 4.2 `packages/shared/src/clarify.ts`（纯函数 + 常量）

```ts
export const CLARIFY_INPUT_PORT_NAME = 'questions' as const
export const CLARIFY_OUTPUT_PORT_NAME = 'answers' as const
export const CLARIFY_SOURCE_PORT_NAME = '__clarify__' as const
export const CLARIFY_RESPONSE_TARGET_PORT_NAME = '__clarify_response__' as const

export const CLARIFY_MAX_QUESTIONS = 5
export const CLARIFY_MAX_OPTIONS_PER_QUESTION = 4
export const CLARIFY_MIN_OPTIONS_PER_QUESTION = 2

/** Parse the JSON body inside <workflow-clarify>. Returns either parsed body or
 *  a list of issues. **Permissive truncation**: questions > 5 are sliced to 5,
 *  options > 4 are sliced to 4, and each slice is recorded as a non-fatal
 *  warning. Hard failures (kind invalid, options < 2, title empty) return
 *  issues[] and a `null` body. */
export function parseClarifyEnvelopeBody(jsonText: string): {
  body: ClarifyEnvelopeBody | null
  warnings: Array<{ code: string; detail: string }>
  errors: Array<{ code: string; detail: string }>
} { /* ... */ }

/** Render the agent-facing markdown block listing what was asked AND what the
 *  user answered. Used for `{{__clarify_answers__}}` token. */
export function buildClarifyPromptBlock(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswer[],
): string { /* ... */ }

/** Deterministic single-sentence English synthesis for one answer.
 *  Cases:
 *   - single, idx selected, no custom: `User chose: "Postgres"`
 *   - single, custom only: `User chose custom answer: "<text>"`
 *   - multi, ≥1 idx, no custom: `User selected: "Python", "TypeScript"`
 *   - multi, idx + custom: `User selected: "Python", "TypeScript" with additional note: "<text>"`
 *   - empty selection + empty custom: `User did not answer this question.` */
export function summariseClarifyAnswer(
  question: ClarifyQuestion,
  answer: ClarifyAnswer,
): string { /* ... */ }
```

### 4.3 `packages/shared/src/prompt.ts` 扩展

新增 `ClarifyPromptContext`：

```ts
export interface ClarifyPromptContext {
  /** Pre-rendered markdown of the questions agent asked last round. */
  questionsBlock?: string
  /** Pre-rendered markdown of the answers (incl. synthesis). */
  answersBlock?: string
  /** Current clarify_iteration; '0' before first ask. */
  iteration?: string
  /** "max - current" string when agent is inside a wrapper-loop with a cap; "" otherwise. */
  remaining?: string
}

export interface RenderPromptInput {
  // ... existing fields ...
  clarifyContext?: ClarifyPromptContext
}
```

`BUILTIN_VARS` 集合扩展：

```ts
const BUILTIN_VARS = new Set([
  // ... existing tokens ...
  '__clarify_questions__',
  '__clarify_answers__',
  '__clarify_iteration__',
  '__clarify_remaining__',
])
```

`renderUserPrompt` 在已有 review auto-append 块之后新增（保持 review section 不动）：

```ts
if (cc !== undefined) {
  if (cc.questionsBlock?.trim() && !referenced.has('__clarify_questions__')) {
    sections += `\n\n## Clarify Q&A — Last-Round Questions\n${cc.questionsBlock}`
  }
  if (cc.answersBlock?.trim() && !referenced.has('__clarify_answers__')) {
    sections += `\n\n## Clarify Q&A — User Answers\n${cc.answersBlock}`
  }
}
```

`buildProtocolBlock(agentOutputs)` **保持不变**；新增 **`buildClarifyProtocolBlock()`** 在 agent 有 clarify channel 时由 runner 追加到 user prompt 末尾（在原 `<workflow-output>` block 之后）：

```ts
export function buildClarifyProtocolBlock(): string {
  return `

---
**Clarify mode is enabled for this node.** If — and ONLY if — you have unresolved questions that block you from producing your normal output, you MUST instead emit a `<workflow-clarify>` block (no `<workflow-output>` in the same reply).

Format:
<workflow-clarify>
{
  "questions": [
    {
      "id": "<stable-id>",            // string, ≤ 64 chars
      "title": "<question text>",     // ≤ 512 chars
      "kind": "single" | "multi",
      "recommended": true | false,
      "options": ["...", "...", "...", "..."]  // 2 to 4 items; do NOT add an "other / free text" option — the UI appends one automatically
    }
    // up to 5 questions, ordered from highest to lowest priority
  ]
}
</workflow-clarify>

**Hard rules — violation is treated as a malformed reply and the node will fail / retry:**
- A reply must contain EITHER one `<workflow-output>` block OR one `<workflow-clarify>` block — NEVER both, NEVER neither.
- Asking back means deferring all output ports to the next round; do not also output partial data.
- Mark only the truly blocking questions as `"recommended": true`. The UI renders an "(推荐)" / "(Recommended)" tag for them.
- Limits: ≤ 5 questions, each question 2–4 options. The framework will truncate over-emissions and log a warning back to your next prompt.
- Once the user submits answers, you will receive them in the next prompt under "## Clarify Q&A — User Answers" plus a deterministic synthesis line per question.`
}
```

## 5. Backend service: `services/clarify.ts`

### 5.1 公开 API

```ts
export interface ClarifyService {
  createClarifySession(opts: {
    taskId: string
    sourceAgentNodeId: string
    sourceAgentNodeRunId: string
    clarifyNodeId: string
    iterationIndex: number
    questions: ClarifyQuestion[]
    truncationWarnings?: Array<{ code: string; detail: string }>
  }): Promise<ClarifySession>

  submitClarifyAnswers(opts: {
    clarifyNodeRunId: string
    answers: ClarifyAnswer[]
    ifMatchIteration?: number
  }): Promise<{ session: ClarifySession; rerunNodeRunId: string }>

  /** Called by scheduler after submitClarifyAnswers: rolls back source agent's
   *  pre_snapshot, mints new node_run (clarify_iteration + 1, retry_index = 0),
   *  and returns its id so scheduler can enqueue it. */
  triggerAgentRerunFromClarify(opts: {
    session: ClarifySession
  }): Promise<{ rerunNodeRunId: string }>

  /** Construct ClarifyPromptContext for the agent's NEXT run, given the latest
   *  answered session for that agent node_run lineage. */
  buildClarifyPromptContext(opts: {
    taskId: string
    agentNodeId: string
    targetIteration: number
  }): Promise<ClarifyPromptContext | undefined>

  cleanupSessionsForTask(taskId: string): Promise<void> // on task delete
}
```

### 5.2 createClarifySession 流程

```
1. zod 校验 questions（用 ClarifyEnvelopeBodySchema），不通过 → 抛 ValidationError（runner 上游 catch）
2. 写 clarify_sessions 行（status='awaiting_human'）
   - source = agent-single 时：sourceShardKey = NULL
   - source = agent-multi 子 shard 时：sourceShardKey = shard 子 node_run.shard_key
3. 把 clarify 节点的 node_run 状态从 pending → awaiting_human
   - agent-single 上游：同一 clarify_node 同 iterationIndex 全局唯一一条 clarify node_run
   - agent-multi 上游：每个反问 shard 各自 mint 一条 clarify node_run（parent_node_run_id 指向多进程父节点的 node_run；shard_key 透传到 clarify node_run.shard_key）
   - 已存在 awaiting_human 的同 source_shard_key clarify node_run 时 idempotent（不会重复 mint，但仍会更新 questionsJson 到最新；这种情况理论上不发生，仅作为防御）
4. broadcast WS clarify.created（payload 含 shard_key 让前端正确路由 + 增量更新 list）
5. scheduler.recomputeTaskStatus(taskId) → task 顶层切到 awaiting_human
```

### 5.3 submitClarifyAnswers 流程（事务内）

```
1. BEGIN
2. SELECT clarify_session FOR UPDATE（SQLite 用 EXCLUSIVE busy 模式）；NOT FOUND → 404
3. 校验：status === 'awaiting_human'；ifMatchIteration 提供时必须 === session.iterationIndex（412 Precondition Failed）
4. zod 校验 answers（SubmitClarifyAnswersSchema）；填回 selectedOptionLabels（按 questions[i].options[idx]）
5. UPDATE clarify_sessions SET answers_json=..., status='answered', answered_at=now, answered_by='local'
6. UPDATE node_runs (clarifyNodeRunId) SET status='done'
7. triggerAgentRerunFromClarify(session) → 新 agent node_run（详见 5.4）
8. COMMIT
9. broadcast WS clarify.answered + task.status_changed（若 task 顶层变化）
```

### 5.4 triggerAgentRerunFromClarify 流程

```
1. 查 source agent node_run（id = session.sourceAgentNodeRunId），拿 pre_snapshot + shard_key（若多进程子）
2. 调 worktree.restoreSnapshot(pre_snapshot)（沿用 review reject 路径已有 helper）
3. 新建一行 node_runs：
   - node_id = session.sourceAgentNodeId
   - iteration = source.iteration (loop iteration 不动)
   - retry_index = 0
   - clarify_iteration = source.clarify_iteration + 1
   - review_iteration = source.review_iteration（透传）
   - status = 'pending'
   - parent_node_run_id = source.parent_node_run_id（透传；agent-multi shard 子 node_run 的 parent 是 multi 父节点 node_run）
   - shard_key = source.shard_key（透传；agent-single 为 NULL）
   - pre_snapshot = 新拍一份（与 retry 同流程）
4. enqueue 新 node_run 到 scheduler 队列
5. （旧 source agent node_run 已经是 'done' 状态——它确实成功跑完吐出了 clarify envelope，状态不改；新 node_run 是它的 clarify-driven sibling，靠 clarify_iteration 区分而非 retry 链）

agent-multi 关键点：父 multi-process 节点的整体调度仍按"等所有 shard 子 done 后聚合"。被 clarify 暂停的 shard 子 node_run 视作"未 done"，父等所有 shard（含被 clarify 暂停后重跑过来 done 的 shard）一起完成才聚合。其它 shard 已 done 的不受影响。
```

### 5.5 buildClarifyPromptContext

```
INPUT: taskId, agentNodeId, targetIteration (即将跑的 agent node_run 的 clarify_iteration)
1. 找 latest answered clarify_session WHERE source_agent_node_id=agentNodeId AND task_id=taskId AND iteration_index < targetIteration ORDER BY iteration_index DESC LIMIT 1
2. 若找不到（targetIteration === 0 时即首次跑）→ return undefined
3. 返回 {
     questionsBlock: renderClarifyQuestionsBlock(session.questions),
     answersBlock: buildClarifyPromptBlock(session.questions, session.answers!),
     iteration: String(targetIteration),
     remaining: <see §5.6>
   }
```

### 5.6 remaining 字段计算

```
1. 查 agent 节点是否在 wrapper-loop 内（通过 definition.nodes 找 wrapper 含本 nodeId）
2. 若是：remaining = String(wrapper.maxIterations - targetIteration)；若 ≤ 0 在 scheduler 早就 exhausted 不会跑到这
3. 不在 loop 内：remaining = ''（agent 看到空字符串 = 不限轮次提示）
```

## 6. envelope 解析（services/envelope.ts 扩展）

```ts
export type DetectedEnvelopeKind = 'output' | 'clarify' | 'both' | 'none'

const OUTPUT_RE = /<workflow-output>[\s\S]*?<\/workflow-output>/g
const CLARIFY_RE = /<workflow-clarify>[\s\S]*?<\/workflow-clarify>/g

export function detectEnvelopeKind(stdout: string): DetectedEnvelopeKind {
  const o = stdout.match(OUTPUT_RE)
  const c = stdout.match(CLARIFY_RE)
  if (o && c) return 'both'
  if (o) return 'output'
  if (c) return 'clarify'
  return 'none'
}

export function extractClarifyEnvelopeBody(stdout: string): string | null {
  const matches = stdout.match(CLARIFY_RE)
  if (!matches || matches.length === 0) return null
  const last = matches[matches.length - 1]
  return last.replace(/^<workflow-clarify>/, '').replace(/<\/workflow-clarify>$/, '').trim()
}
```

`runner.ts` 在节点完成时（agent 进程退出后）改造 envelope 分支。**agent-single 和 agent-multi 子 shard 走同一条 envelope 检测路径**——`runNode` 不需要区分调用方：

```ts
const kind = detectEnvelopeKind(stdout)
if (kind === 'both') {
  fail(nodeRun, 'clarify-and-output-both-present', 'agent reply contains BOTH envelopes; choose exactly one')
  return
}
if (kind === 'clarify') {
  const body = extractClarifyEnvelopeBody(stdout)!
  const { body: parsed, warnings, errors } = parseClarifyEnvelopeBody(body)
  if (errors.length > 0 || !parsed) {
    fail(nodeRun, errors[0]?.code ?? 'clarify-questions-malformed', errors[0]?.detail ?? '')
    return
  }
  await clarifyService.createClarifySession({
    taskId,
    sourceAgentNodeId,
    sourceAgentNodeRunId: nodeRun.id,           // for agent-multi, this is the shard child node_run id
    sourceShardKey: nodeRun.shardKey ?? null,    // NULL when agent-single
    clarifyNodeId: findClarifyNodeForAgent(definition, sourceAgentNodeId)!,
    iterationIndex: nodeRun.clarifyIteration,
    questions: parsed.questions,
    truncationWarnings: warnings.length > 0 ? warnings : undefined,
  })
  markNodeRunDone(nodeRun) // agent 节点本身是 done（吐出了 valid clarify），状态由 clarify 节点接管
  return
}
// kind === 'none' or 'output' → 走原有路径
```

对于 agent-multi 父节点的聚合判定（scheduler.ts 既有逻辑）：父节点 ready-to-aggregate 的判定从"所有 shard 子 done"扩展为"所有 shard 子 done **且** 没有任何 shard 还在挂 awaiting_human 的 clarify_session（即所有反问已被答完并 shard 重跑到 done）"。clarify 暂停的 shard 期间父节点保持 running，task 顶层显示 awaiting_human。

## 7. Scheduler 扩展

### 7.1 节点 ready 判定

clarify 节点的 ready 判定**不同于普通节点**：

```
- 普通节点 ready = 所有 input edge 上游 done && 上游 output ports 有产数据
- clarify 节点 ready = 上游 agent node_run 完成且产出 <workflow-clarify> envelope
  （等价：上游 agent node_run 关联的 clarify_session 存在 + status='awaiting_human'）
```

实际实现上 runner 在 createClarifySession 时直接把 clarify 节点 node_run 标 awaiting_human，scheduler 不需要 ready 重新计算；下次 tick 看到 awaiting_human 仍 idle。

### 7.2 scheduler 队列循环新增分支

```ts
// scheduler tick 主循环
for (const nodeRun of pendingRuns) {
  if (nodeRun.kind === 'clarify') {
    // clarify 节点不主动调度；ready/awaiting_human 状态由 runner.createClarifySession 设置
    continue
  }
  // ... existing dispatch logic ...
}
```

### 7.3 recomputeTaskStatus 优先级

```
1. 任意 node_run.status === 'failed' AND task.retries 已尽 → task.status='failed'
2. 任意 node_run.status === 'awaiting_human' → task.status='awaiting_human'
3. 任意 node_run.status === 'awaiting_review' → task.status='awaiting_review'
4. 所有 node_run.status ∈ {done, skipped} → task.status='done'
5. 否则 → task.status='running'
```

awaiting_human 优先级高于 awaiting_review，是因为 clarify 是 agent 主动暂停（更主动语义），UI 上"任务在等你答题"比"任务在等你审稿"通常更紧迫。但这只影响顶层 chip；左栏两个 badge（review 待审数 / clarify 待答数）独立显示。

### 7.4 agent node prompt 注入接入点

`scheduler.ts` 在调用 `runner.runNode(nodeRun)` 前组装 prompt context：

```ts
const reviewCtx = await reviewService.buildReviewPromptContext({...}) // 已有
const clarifyCtx = await clarifyService.buildClarifyPromptContext({
  taskId: nodeRun.taskId,
  agentNodeId: nodeRun.nodeId,
  targetIteration: nodeRun.clarifyIteration,
})
const prompt = renderUserPrompt({
  promptTemplate: node.promptTemplate,
  inputs: resolvedInputs,
  meta: { ... },
  agentOutputs: agent.outputs.map(getOutputName),
  reviewContext: reviewCtx,
  clarifyContext: clarifyCtx,
})
const promptWithProtocols = prompt + (agentHasClarifyChannel(definition, nodeRun.nodeId) ? buildClarifyProtocolBlock() : '')
```

## 8. REST routes

### `GET /api/clarify`

Query: `?task=<id>&status=awaiting_human|answered|all`（默认 `awaiting_human`）→ 返回 ClarifySession 列表（不含 questions_json/answers_json 大字段，含 summary）。

### `GET /api/clarify/:nodeRunId`

返回 ClarifySession 全字段（含 questions + answers JSON）。

### `POST /api/clarify/:nodeRunId/answers`

Body: `SubmitClarifyAnswers`。乐观锁通过 `If-Match: iterationIndex` 头 / body 字段。返回 `{ session: ClarifySession, rerunNodeRunId }`。

### `GET /api/clarify/pending-count`

返回 `{ count: number }`，左栏 badge 用。

## 9. WS 事件

`packages/shared/src/schemas/ws.ts`：

```ts
export const ClarifyCreatedEventSchema = z.object({
  type: z.literal('clarify.created'),
  taskId: z.string(),
  clarifyNodeRunId: z.string(),
  iterationIndex: z.number().int(),
})
export const ClarifyAnsweredEventSchema = z.object({
  type: z.literal('clarify.answered'),
  taskId: z.string(),
  clarifyNodeRunId: z.string(),
  rerunNodeRunId: z.string(),
})
```

Broadcast 通道：`/ws/tasks/{taskId}`（与 review.* 同通道——review 也在 TaskWsMessageSchema 内）。前端 `/clarify` 全局 list 走轮询 + invalidate（与 RFC-005 Reviews tab 同模式），detail 路由订阅 task 频道；服务端在 createClarifySession / submitClarifyAnswers 末尾 broadcast。

## 10. Canvas / Editor

### 10.1 反向拖动建两条边

`packages/frontend/src/components/canvas/clarifyDragHelper.ts`：

```ts
export function buildClarifyEdges(
  sourceAgentNodeId: string,
  clarifyNodeId: string,
): WorkflowEdge[] {
  const baseId = `e_${sourceAgentNodeId}_${clarifyNodeId}`
  return [
    {
      id: `${baseId}_clarify`,
      source: { nodeId: sourceAgentNodeId, portName: CLARIFY_SOURCE_PORT_NAME },
      target: { nodeId: clarifyNodeId, portName: CLARIFY_INPUT_PORT_NAME },
    },
    {
      id: `${baseId}_answers`,
      source: { nodeId: clarifyNodeId, portName: CLARIFY_OUTPUT_PORT_NAME },
      target: { nodeId: sourceAgentNodeId, portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
    },
  ]
}

export function isValidClarifyTarget(sourceNode: WorkflowNode): boolean {
  // v1 supports both agent kinds. Excluded: wrapper-git / wrapper-loop / review / output / input / clarify.
  return sourceNode.kind === 'agent-single' || sourceNode.kind === 'agent-multi'
}
```

`WorkflowCanvas.handleConnect`：

```ts
// 反向拖动：from clarify input handle to agent node
if (target.kind === 'clarify' && targetHandleId === CLARIFY_INPUT_PORT_NAME) {
  if (!isValidClarifyTarget(source)) {
    // toast + reject
    return
  }
  // 检查这个 agent 是否已挂另一个 clarify → 已挂则禁止（validator clarify-multiple-clarify-on-same-agent）
  if (agentHasClarifyChannel(definition, source.id)) {
    // toast
    return
  }
  const [e1, e2] = buildClarifyEdges(source.id, target.id)
  appendEdges([e1, e2])
  return
}
```

### 10.2 ClarifyNode 视觉

```tsx
// packages/frontend/src/components/canvas/nodes/ClarifyNode.tsx
export function ClarifyNode({ data }: NodeProps<ClarifyNodeData>) {
  const status = data.statusOverlay ?? 'pending'
  return (
    <div className={`canvas-node canvas-node--clarify status-${status}`}>
      <Handle type="target" position={Position.Left} id={CLARIFY_INPUT_PORT_NAME} />
      <div className="canvas-node__header">
        <span className="header-pill">反问澄清</span>
        <span className="canvas-node__title">{data.title || '反问'}</span>
      </div>
      <Handle type="source" position={Position.Right} id={CLARIFY_OUTPUT_PORT_NAME} />
    </div>
  )
}
```

### 10.3 NodeInspector clarify 分支

只读字段：

```
- title (input)
- description (textarea)
- "已挂接到 agent": 显示 sourceAgentNodeId（点击跳到该 agent 节点）；如 missing 显示红字
- "包裹在 wrapper-loop 内": yes/no（no 时 muted 提示"建议套在 loop 内以加 max_iterations 上限"）
```

端口不可编辑。

## 11. Frontend `/clarify` 路由

### 11.1 list 路由 `/clarify`

```
- segmented filter: 待回答 (default) / 已回答 / 全部
- table by task; each row: clarify 节点 title / asking agent name / iteration / questions count / time
- 点击 row → /clarify/:nodeRunId
- 顶部 toolbar: 刷新按钮 + segmented + 搜索（按 task / agent）
```

### 11.2 detail 路由 `/clarify/:nodeRunId`

```
- 顶部 context card: "由 agent {agentName} 发起，第 {iteration} 轮反问，触发节点 {nodeId}"
  - agent-multi 上游时额外显示 "Shard: {shard_key}"
- 顶部 warning bar（如果有 truncation_warnings）
- agent-multi shard 切换器（仅当同一 task 同一 clarifyNodeId 下有 ≥ 2 个 awaiting_human shard 时显示）:
  - 按 shard_key 字典序排列的 segmented control，每项显示 shard_key + status icon（待答/已答）
  - 切到下一 shard 不丢当前 shard 的 draft（draftStore key 含 nodeRunId 维度）
- 主区: 问题列表（QuestionForm 一题一行）
- 右侧（可选）: 历史 sessions 列表（同 clarify 节点 + 同 agent 之前的 sessions，只读，按 iterationIndex DESC）
- 底部: 提交按钮 + draft 保存指示器
```

### 11.3 QuestionForm 组件

```tsx
type Props = {
  question: ClarifyQuestion
  value: ClarifyAnswer
  onChange: (v: ClarifyAnswer) => void
  index: number // 1-based for hotkey
}

// single:
//   radio[1..N] for question.options
//   radio[N+1] "其他（自定义）" → 选中则清空 selectedOptionIndices, 启用 textarea
//
// multi:
//   checkbox[1..N] for question.options
//   独立 checkbox "也包含以下补充" → 选中则启用 textarea；不互斥
//
// Hotkey: 数字键 1-N+1 选 N-th option (single only); for multi, 数字键 toggle that option
```

### 11.4 draft 持久化

```
key = `${taskId}:${clarifyNodeRunId}:${sessionId}`
value = ClarifyAnswer[]
读：进入 detail 路由 useEffect 初始 load
写：每次 onChange debounce 500ms 写一次
清：成功提交后 delete
```

## 12. i18n 键索引（约 30 条新 key）

```
clarify.nav.label                       — 左栏 "反问澄清"
clarify.list.title
clarify.list.filter.awaiting           — "待回答"
clarify.list.filter.answered           — "已回答"
clarify.list.filter.all                — "全部"
clarify.list.empty                     — "没有待回答的反问"
clarify.detail.contextCard             — "由 agent {{name}} 发起 · 第 {{n}} 轮反问"
clarify.detail.truncationWarning       — "Agent 提了 {{got}} 题，已截到前 {{kept}} 题"
clarify.detail.submit                  — "全部提交"
clarify.detail.draftSaving             — "正在保存草稿…"
clarify.detail.draftSaved              — "草稿已保存（关 tab 不丢）"
clarify.detail.recommendedChip         — "推荐"
clarify.detail.requiredMissing         — "请先回答所有推荐题"
clarify.question.single.customLabel    — "其他（自定义）"
clarify.question.multi.customLabel     — "也包含以下补充"
clarify.question.multi.customPlaceholder— "在此填写补充内容…"
clarify.question.custom.lengthHint     — "最多 2000 字"
clarify.canvas.palette.label           — "反问澄清"
clarify.canvas.palette.tip             — "从 input 端拖到 agent 节点上建立反问通道"
clarify.canvas.error.multiNotSupported — "v1 暂不支持 agent-multi 节点连入反问节点"
clarify.canvas.error.duplicate         — "该 agent 已挂接另一个反问节点"
clarify.validator.noIterationCap       — "裸用反问节点不限制反问轮次，建议套在 wrapper-loop 内"
clarify.validator.answersDisconnected  — "answers 端口未连出。注入路径仍生效，但建议在画布上明示数据流向"
clarify.ws.toast.othersSubmitted       — "另一处已提交答案，本页已切换为只读"
clarify.inspector.title                — "反问节点配置"
clarify.inspector.linkedAgent          — "已挂接到 agent"
clarify.inspector.linkedAgentMissing   — "未挂接到任何 agent"
clarify.inspector.inLoop               — "在 wrapper-loop 内"
clarify.inspector.notInLoop            — "未在 wrapper-loop 内"
clarify.task.status.label              — "等待用户回答"
```

英文 mirror 同步。

## 13. 测试矩阵索引（详见 plan.md）

| 模块 | 文件 | case 数 |
| --- | --- | --- |
| shared schemas | tests/clarify-schemas.test.ts | 5 |
| envelope parse | tests/envelope-clarify-parse.test.ts | 6 |
| services/clarify | tests/clarify-service.test.ts | 8 |
| scheduler | tests/scheduler-clarify-dispatch.test.ts | 7（含 agent-multi fan-out 部分 shard 反问 + 单 shard 答完仅重跑该 shard + 父节点等所有 shard done 才聚合 + agent-single happy path + clarify_iteration 递增 + 不重置 retry_index + agent-multi 全 shard 反问后串行答完）|
| REST + WS | tests/routes-clarify.test.ts + ws-clarify.test.ts | 6（list 含 shard_key + GET detail + POST answers + clarify.created broadcast 带 shard_key + clarify.answered broadcast + 同 task 多 shard 列表分组顺序）|
| canvas drag | tests/canvas-clarify-drag.test.ts | 5（反向拖到 agent-single + 反向拖到 agent-multi + 拒 wrapper / review / output / input / clarify 自身 + 同 agent 第二次拖入拒绝 + 删 answers→agent 边后注入仍正常的源码层断言）|
| QuestionForm | tests/clarify-question-form.test.tsx | 8 |
| /clarify routes | tests/clarify-routes.test.tsx | 6（list filter + detail 进入 + 推荐 chip 顺序 + 多 tab WS 同步 + draft 恢复 + shard 切换器）|
| shared utils | tests/clarify-utils.test.ts | 7 |
| validator | tests/workflow-validator-clarify.test.ts | 5 |
| regression | tests/clarify-envelope-exclusive.test.ts + clarify-prompt-injection.test.ts + clarify-options-cap.test.ts + clarify-no-cross-review-interference.test.ts + clarify-target-validator.test.ts + clarify-reverse-drag-two-edges.test.ts | 6 spec files |
| e2e | e2e/clarify.spec.ts | 1 |

backend +32, frontend +26, shared +12（合在 backend tests 包内的部分单独算 shared 那 5 case 是双跑）, e2e +1。

## 14. 与 design.md 的同步点

完工时（PR-E）改 `design/design.md`：

- §3 数据模型：表索引追加 `clarify_sessions` + `node_runs.clarify_iteration`。
- §5 节点类型：clarify 加入第 8 类节点，与 review 同章节风格。
- §7.4 envelope：加 `<workflow-clarify>` 协议块说明 + 互斥规则。
- §9 节点状态机：awaiting_human 状态加入，标注与 awaiting_review 并列且优先级更高。
- §4.3 WS 频道：clarify.created / clarify.answered 加入事件列表。
- §11 配置：本 RFC 不引入新 settings 字段（draft 限额走前端 maxLength + zod max(2000) 兜底）。

## 15. 性能 & 风险

| 项 | 风险 | 缓解 |
| --- | --- | --- |
| clarify_sessions 表查询 N+1（detail 页查 questions/answers + 历史 sessions） | 低 | 单 task 内 sessions 数典型 ≤ 5，索引 `idx_clarify_sessions_task` 已覆盖 |
| protocol block 加在 user prompt 末尾让 agent 上下文变长 | 极低 | block 体积 < 1KB，与现有 `<workflow-output>` block 同量级 |
| WS broadcast 风暴（同一 task 多 tab） | 低 | clarify event 总量级 = sessions 数（< 10），与 review 同量级 |
| draft IndexedDB 旧条目堆积 | 低 | 提交时清；GC 由浏览器；不暴露用户问题 |
| migration 0007 在 SQLite enum 重建路径上 lose data | 中 | T2 强制 migration test 用真实 v2 SQLite 文件断言 row count + 字段不变 |

## 16. 与 RFC-005 / RFC-007 / RFC-014 的代码隔离审计

| 文件 | 本 RFC 改动行数（粗估） | review 路径是否变化 |
| --- | --- | --- |
| `services/review.ts` | 0 | 否 |
| `services/scheduler.ts` | +60（clarify dispatch / recomputeTaskStatus 加 awaiting_human / clarify ready 短路） | 否（既有 review reject/iterate 分支零接触） |
| `services/runner.ts` | +50（envelope kind detect + createClarifySession 调用） | 否（既有 envelope 解析路径作为 'output' 分支保留） |
| `services/prompt.ts` | +20（4 token case） | 否 |
| `WorkflowCanvas.handleConnect` | +30（clarify branch 与 review/output branch 并列） | 否 |
| `NodeInspector.tsx` | +40（clarify branch） | 否 |
| `__root.tsx` | +5（badge） | 否 |
| `i18n/{zh-CN,en-US}.ts` | +60 lines | 否 |

CI 应额外加一条 grep 守卫（T6 测试里写）：

```
grep -c 'reviewIteration' packages/backend/src/services/review.ts
# expected value before this RFC's PR equals value after — diff = 0
```
