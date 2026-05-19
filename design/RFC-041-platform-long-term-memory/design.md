# RFC-041 — Platform Long-Term Memory · 技术设计

## 0. 阅读顺序

`proposal.md` 给出产品意图；本文按 **数据模型 → 信号入队 → distiller 协议 → 注入算法 → 路由与 WS → UI → 测试策略 → PR 拆分** 的顺序展开实现细节。每个章节末尾标注与既有代码 / RFC 的 wire-up 点。

## 1. 改动范围一览

| 层 | 文件 | 改动 |
|---|---|---|
| migration | `packages/backend/db/migrations/0023_rfc041_memories.sql` | 新增 3 表 + 索引 |
| db schema | `packages/backend/src/db/schema.ts` | drizzle 模型新增 `memories` / `memory_distill_jobs` / `task_feedback` |
| shared schemas | `packages/shared/src/schemas/memory.ts`（新） | `MemoryScopeSchema` / `MemorySchema` / `MemorySummarySchema` / `MemoryCandidatePromoteSchema` / `MemoryDistillJobSchema` 等 |
| shared schemas | `packages/shared/src/schemas/taskFeedback.ts`（新） | `TaskFeedbackSchema` / `TaskFeedbackCreateSchema` |
| shared schemas | `packages/shared/src/schemas/config.ts` | 加 `memoryDistillerEnabled?: boolean` + `memoryInjectionBudget?: { agent / workflow / repo / global: number }` + `memoryDistillModel?: string` |
| shared schemas | `packages/shared/src/schemas/ws.ts` | 加 `MemoryWsMessage` / `MemoryDistillJobWsMessage` discriminated unions |
| shared index | `packages/shared/src/index.ts` | barrel re-export 新 schema |
| backend services | `packages/backend/src/services/memory.ts`（新） | CRUD + promote + supersede 链 + listInjectable |
| backend services | `packages/backend/src/services/memoryInject.ts`（新） | `loadInjectableMemories(taskId, agentId)` + `formatMemoryBlock` + token budget clip |
| backend services | `packages/backend/src/services/memoryDistiller.ts`（新） | `runDistill(jobId)` + `buildDistillerInlineAgent()` + `parseDistillerOutput` |
| backend services | `packages/backend/src/services/memoryDistillScheduler.ts`（新） | `enqueueDistillJob` + `startMemoryDistillLoop` 后台 1Hz worker |
| backend services | `packages/backend/src/services/taskFeedback.ts`（新） | CRUD + 入队 distill |
| backend services | `packages/backend/src/services/clarify.ts` | clarify_session completed 一次性入队 distill job |
| backend services | `packages/backend/src/services/reviews.ts` | review decision 写入后入队 distill job |
| backend services | `packages/backend/src/services/runner.ts` | inline agent JSON 末尾调 `formatMemoryBlock` 注入 |
| backend routes | `packages/backend/src/routes/memories.ts`（新） | 6 个接口 |
| backend routes | `packages/backend/src/routes/memoryDistillJobs.ts`（新） | 3 个接口 |
| backend routes | `packages/backend/src/routes/taskFeedback.ts`（新） | 2 个接口 |
| backend ws | `packages/backend/src/ws/broadcaster.ts` | 加 `memoryBroadcaster` / `memoryDistillJobBroadcaster` + 通道常量 |
| backend cli | `packages/backend/src/cli/start.ts` | daemon 启动调 `startMemoryDistillLoop()` + graceful shutdown stop |
| backend auth | `packages/backend/src/auth/permissions.ts` | PERMISSIONS 字面量加 5 项；ROLE_PERMISSIONS 映射 admin / user 各自集合 |
| frontend routes | `packages/frontend/src/routes/memory.tsx`（新）+ `memory/approval-queue.tsx` / `all.tsx` / `by-scope.tsx` / `distill-jobs.tsx` | 路由 + 子路由 |
| frontend components | `packages/frontend/src/components/memory/` 6 个新组件（见 §6） | UI |
| frontend components | `packages/frontend/src/components/tasks/TaskFeedbackList.tsx`（新） | 任务详情页留言区 |
| frontend shell | `packages/frontend/src/components/shell/AppShell.tsx`（或 `routes/__root.tsx`） | 顶栏新 "Memory" tab |
| frontend shell | `packages/frontend/src/components/shell/InboxDrawer.tsx` | 加 "Pending memory" 分组（admin） |
| frontend agents/workflows/repos | 各 detail 路由 | 加 "Memories" 子 tab，嵌入 `<MemoryScopedList />` |
| frontend hooks | `packages/frontend/src/hooks/useMemoryWs.ts`（新） / `useMemoryDistillJobWs.ts`（新） | WS subscribe |
| frontend lib | `packages/frontend/src/lib/memory.ts`（新） | 纯函数：`promoteActionToLabel` / `formatMemoryRow` / `groupCandidatesByScope` 等 |
| i18n | `packages/frontend/src/i18n/locales/{zh-CN,en-US}.ts` | +约 32 key |
| e2e | `e2e/tests/memory.spec.ts`（新） + `stub-opencode-memory-distiller.sh`（新） | 1 spec |
| styles | `packages/frontend/src/styles.css` | `.memory-*` / `.task-feedback-*` 命名空间 |

**零改动清单**：opencode 源码（仅依赖现有 `OPENCODE_CONFIG_CONTENT` + `<workflow-output>` envelope 协议）；workflow YAML schema；agent frontmatter；review_doc decision schema；clarify envelope；RFC-039 文案；RFC-040 wrapper_progress；既有 inventory snapshot 表（RFC-029）。

## 2. 数据模型 / DDL

### 2.1 `memories` 表

```sql
CREATE TABLE memories (
  id             TEXT    PRIMARY KEY,
  scope_type     TEXT    NOT NULL CHECK (scope_type IN ('agent','workflow','repo','global')),
  scope_id       TEXT,            -- NULL for global
  title          TEXT    NOT NULL,
  body_md        TEXT    NOT NULL,
  tags           TEXT    NOT NULL DEFAULT '[]',  -- JSON array of strings
  status         TEXT    NOT NULL CHECK (status IN ('candidate','approved','archived','superseded','rejected')),
  source_kind    TEXT    NOT NULL CHECK (source_kind IN ('clarify','review','feedback','manual')),
  source_event_id TEXT,           -- clarify_sessions.id / review_docs.id / task_feedback.id / NULL
  source_task_id TEXT,
  distill_job_id TEXT,
  distill_action TEXT             CHECK (distill_action IN ('new','update_of','duplicate_of','conflict_with')),
  supersedes_id  TEXT             REFERENCES memories(id) ON DELETE SET NULL,
  superseded_by_id TEXT           REFERENCES memories(id) ON DELETE SET NULL,
  approved_by_user_id TEXT,
  approved_at    INTEGER,
  created_at     INTEGER NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  CHECK (
    (scope_type = 'global' AND scope_id IS NULL) OR
    (scope_type != 'global' AND scope_id IS NOT NULL)
  )
);

CREATE INDEX idx_memories_scope_status        ON memories(scope_type, scope_id, status);
CREATE INDEX idx_memories_status_created      ON memories(status, created_at);
CREATE INDEX idx_memories_supersedes          ON memories(supersedes_id);
CREATE INDEX idx_memories_source              ON memories(source_kind, source_event_id);
```

字段说明：
- **`scope_type` + `scope_id`**：scope_type='global' 时 scope_id MUST NULL（CHECK 强约束）；其它三类必须填 id 字符串（agent.id / workflow.id / cached_repo.id）。
- **`tags`** = JSON 字符串数组（lowercase-kebab；distiller prefers existing）。
- **`status`** 状态机：`candidate → approved | rejected`（admin promote）；`approved → archived | superseded`（admin archive / 新 candidate approve_and_supersede）；`archived → approved`（admin un-archive，仅 UI 提供，本 RFC 实现，免得用户 archive 错了要重新审批）；终态 = `rejected` / `superseded`。
- **`source_*`**：`candidate` 必有，`manual` 来源（admin 手写）source_event_id 可为 NULL。
- **`distill_action`** 仅 candidate 阶段有意义；approve 时记录原 action 便于审计。
- **`supersedes_id` / `superseded_by_id`**：单向链：A.supersedes_id=B → B.superseded_by_id=A。同时设置（事务原子）。
- **`version`** = supersede 链深度（默认 1，supersede 创建时 = parent.version + 1）。

### 2.2 `memory_distill_jobs` 表

```sql
CREATE TABLE memory_distill_jobs (
  id                TEXT    PRIMARY KEY,
  debounce_key      TEXT    NOT NULL,  -- e.g. 't_01HXY...:clarify'
  source_kind       TEXT    NOT NULL CHECK (source_kind IN ('clarify','review','feedback')),
  source_event_id   TEXT    NOT NULL,
  task_id           TEXT,
  scope_resolved_json TEXT  NOT NULL,  -- JSON: {agentIds: string[], workflowId?: string, repoId?: string, includeGlobal: true}
  status            TEXT    NOT NULL CHECK (status IN ('pending','running','done','failed','canceled')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_run_at       INTEGER NOT NULL,
  last_error        TEXT,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER
);

CREATE INDEX idx_distill_jobs_status_next  ON memory_distill_jobs(status, next_run_at);
CREATE INDEX idx_distill_jobs_debounce     ON memory_distill_jobs(debounce_key, status);
CREATE INDEX idx_distill_jobs_task         ON memory_distill_jobs(task_id, source_kind);
```

字段说明：
- **`debounce_key`** = `${task_id}:${source_kind}`（manual 入队由后期 v1.x 决定，本 RFC 不开）。同 key 的 `pending` 行在 worker 拾起时**合并为单次 distill**（payload 列所有 source_event_id）。
- **`scope_resolved_json`** = enqueue 时算好的 scope 集合，distiller 直接读，不再回查 task。
- **`status`** 终态 = done / failed / canceled。
- **`attempts`** = 已重试次数；`next_run_at` 失败后按 `now + 2^attempts * 30s` 延后。

### 2.3 `task_feedback` 表

```sql
CREATE TABLE task_feedback (
  id              TEXT    PRIMARY KEY,
  task_id         TEXT    NOT NULL,
  author_user_id  TEXT,            -- nullable for legacy "local" user (RFC-036 兼容)
  body_md         TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  distilled       INTEGER NOT NULL DEFAULT 0,  -- 0/1
  distill_job_id  TEXT
);

CREATE INDEX idx_task_feedback_task ON task_feedback(task_id, created_at DESC);
```

字段说明：
- `body_md` zod 校验 trim 后 1..4000；超出 422。
- `distilled=1` 仅表"已入队 distill"，不代表 distill 已完成（更细状态查 `memory_distill_jobs`）。
- 不级联删 task：rfc-041 不引 ON DELETE CASCADE（保留留言历史，task 软关联）。

### 2.4 索引选型理由

- `idx_memories_scope_status` —— 最热路径：runner 每次 runNode 都按 `(scope_type, scope_id, status='approved')` 拉，覆盖 4 scope 同时查。
- `idx_memories_status_created` —— admin 审批队列：`WHERE status='candidate' ORDER BY created_at DESC`。
- `idx_distill_jobs_status_next` —— daemon 1Hz worker：`WHERE status='pending' AND next_run_at <= now ORDER BY next_run_at`。
- `idx_distill_jobs_debounce` —— 合并查找：`WHERE debounce_key=? AND status='pending'`。

## 3. shared schemas

### 3.1 `packages/shared/src/schemas/memory.ts`

```ts
import { z } from 'zod'

export const MemoryScopeSchema = z.enum(['agent', 'workflow', 'repo', 'global'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const MemoryStatusSchema = z.enum(['candidate', 'approved', 'archived', 'superseded', 'rejected'])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

export const MemorySourceKindSchema = z.enum(['clarify', 'review', 'feedback', 'manual'])

export const DistillActionSchema = z.enum(['new', 'update_of', 'duplicate_of', 'conflict_with'])

export const MemorySchema = z
  .object({
    id: z.string(),
    scopeType: MemoryScopeSchema,
    scopeId: z.string().nullable(),
    title: z.string().min(1).max(120),
    bodyMd: z.string().min(1).max(4000),
    tags: z.array(z.string().min(1).max(40)).max(16),
    status: MemoryStatusSchema,
    sourceKind: MemorySourceKindSchema,
    sourceEventId: z.string().nullable(),
    sourceTaskId: z.string().nullable(),
    distillJobId: z.string().nullable(),
    distillAction: DistillActionSchema.nullable(),
    supersedesId: z.string().nullable(),
    supersededById: z.string().nullable(),
    approvedByUserId: z.string().nullable(),
    approvedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    version: z.number().int().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType === 'global' && v.scopeId !== null) {
      ctx.addIssue({ code: 'custom', message: 'global scope must have scopeId=null', path: ['scopeId'] })
    }
    if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
      ctx.addIssue({ code: 'custom', message: 'non-global scope requires scopeId', path: ['scopeId'] })
    }
  })

export type Memory = z.infer<typeof MemorySchema>

export const MemorySummarySchema = z.object({
  id: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  title: z.string(),
  status: MemoryStatusSchema,
  tags: z.array(z.string()),
  approvedAt: z.number().int().nullable(),
  version: z.number().int(),
  distillAction: DistillActionSchema.nullable(),
})

export const MemoryCandidatePromoteSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), tagsOverride: z.array(z.string()).optional() }),
  z.object({
    action: z.literal('approve_and_supersede'),
    supersedeIds: z.array(z.string()).min(1).max(8),
    tagsOverride: z.array(z.string()).optional(),
  }),
  z.object({ action: z.literal('reject') }),
])

export const MemoryDistillJobSchema = z.object({
  id: z.string(),
  debounceKey: z.string(),
  sourceKind: z.enum(['clarify', 'review', 'feedback']),
  sourceEventId: z.string(),
  taskId: z.string().nullable(),
  scopeResolved: z.object({
    agentIds: z.array(z.string()),
    workflowId: z.string().nullable(),
    repoId: z.string().nullable(),
    includeGlobal: z.boolean(),
  }),
  status: z.enum(['pending', 'running', 'done', 'failed', 'canceled']),
  attempts: z.number().int(),
  nextRunAt: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
})
```

### 3.2 `packages/shared/src/schemas/taskFeedback.ts`

```ts
export const TaskFeedbackSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  authorUserId: z.string().nullable(),
  bodyMd: z.string().min(1).max(4000),
  createdAt: z.number().int(),
  distilled: z.boolean(),
  distillJobId: z.string().nullable(),
})

export const TaskFeedbackCreateSchema = z.object({
  bodyMd: z.string().trim().min(1).max(4000),
})
```

### 3.3 `schemas/config.ts` 新字段

```ts
memoryDistillerEnabled: z.boolean().default(true),
memoryDistillModel: z.string().optional(),  // 默认走 runtime default model
memoryInjectionBudget: z
  .object({
    agent: z.number().int().min(0).max(8000).default(1500),
    workflow: z.number().int().min(0).max(8000).default(800),
    repo: z.number().int().min(0).max(8000).default(800),
    global: z.number().int().min(0).max(8000).default(500),
  })
  .default({ agent: 1500, workflow: 800, repo: 800, global: 500 }),
```

### 3.4 `schemas/ws.ts` discriminated union

```ts
export const MemoryWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('memory.candidate.created'), memory: MemorySummarySchema }),
  z.object({
    type: z.literal('memory.candidate.promoted'),
    memoryId: z.string(),
    newStatus: z.enum(['approved', 'rejected']),
    supersededIds: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal('memory.archived'), memoryId: z.string() }),
  z.object({ type: z.literal('memory.superseded'), oldId: z.string(), newId: z.string() }),
])

export const MemoryDistillJobWsMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('distill.queued'), jobId: z.string(), debounceKey: z.string() }),
  z.object({ type: z.literal('distill.started'), jobId: z.string() }),
  z.object({ type: z.literal('distill.done'), jobId: z.string(), candidatesCreated: z.number().int() }),
  z.object({ type: z.literal('distill.failed'), jobId: z.string(), error: z.string() }),
])
```

## 4. 信号入队（scheduler 端）

### 4.1 入口点

| 信号源 | 入口函数 | 入队时点 |
|---|---|---|
| clarify | `services/clarify.ts::completeClarifySession(sessionId)` | 状态首次 `awaiting_human → completed` 时 |
| review  | `services/reviews.ts::recordReviewDecision(reviewId, decision)` | 状态首次 `awaiting_human → accepted/rejected` 时 |
| feedback| `services/taskFeedback.ts::createTaskFeedback(taskId, body)` | 行 insert 成功后立即 |

### 4.2 `enqueueDistillJob`

```ts
// services/memoryDistillScheduler.ts
const DEBOUNCE_MS = 5_000

export function enqueueDistillJob(opts: {
  sourceKind: 'clarify' | 'review' | 'feedback'
  sourceEventId: string
  taskId: string | null
}): { jobId: string; debounceKey: string } {
  const debounceKey = opts.taskId ? `${opts.taskId}:${opts.sourceKind}` : `noTask:${opts.sourceKind}:${opts.sourceEventId}`
  const scopeResolved = opts.taskId ? computeEligibleScopes(opts.taskId) : { agentIds: [], workflowId: null, repoId: null, includeGlobal: true }
  const jobId = ulid()
  db.insert(memoryDistillJobs).values({
    id: jobId,
    debounceKey,
    sourceKind: opts.sourceKind,
    sourceEventId: opts.sourceEventId,
    taskId: opts.taskId,
    scopeResolvedJson: JSON.stringify(scopeResolved),
    status: 'pending',
    attempts: 0,
    nextRunAt: Date.now() + DEBOUNCE_MS,
    createdAt: Date.now(),
  }).run()
  memoryDistillJobBroadcaster.publish({ type: 'distill.queued', jobId, debounceKey })
  return { jobId, debounceKey }
}

function computeEligibleScopes(taskId: string): ResolvedScope {
  const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get()
  if (!task) return { agentIds: [], workflowId: null, repoId: null, includeGlobal: true }
  // workflowSnapshot JSON 抽所有 agent-single / agent-multi 节点的 agentName -> resolve to id
  const agentNames = extractAgentNamesFromSnapshot(task.workflowSnapshot)
  const agentIds = db.select({ id: agents.id }).from(agents).where(inArray(agents.name, agentNames)).all().map(r => r.id)
  return { agentIds, workflowId: task.workflowId ?? null, repoId: task.repoId ?? null, includeGlobal: true }
}
```

### 4.3 daemon worker

```ts
let timer: ReturnType<typeof setInterval> | null = null
let stopping = false

export function startMemoryDistillLoop(): void {
  if (!getConfig().memoryDistillerEnabled) return
  timer = setInterval(tick, 1000)
}
export async function stopMemoryDistillLoop(): Promise<void> {
  stopping = true
  if (timer) clearInterval(timer)
  // mark running jobs back to pending so next start picks up
  db.update(memoryDistillJobs).set({ status: 'pending' }).where(eq(memoryDistillJobs.status, 'running')).run()
}

async function tick() {
  if (stopping) return
  const now = Date.now()
  const due = db.select().from(memoryDistillJobs)
    .where(and(eq(memoryDistillJobs.status, 'pending'), lte(memoryDistillJobs.nextRunAt, now)))
    .orderBy(memoryDistillJobs.nextRunAt)
    .limit(5).all()
  for (const job of due) {
    // 合并同 debounce_key 的其它 pending
    const siblings = db.select().from(memoryDistillJobs)
      .where(and(eq(memoryDistillJobs.debounceKey, job.debounceKey), eq(memoryDistillJobs.status, 'pending')))
      .all()
    const ids = siblings.map(s => s.id)
    db.update(memoryDistillJobs).set({ status: 'running', startedAt: now }).where(inArray(memoryDistillJobs.id, ids)).run()
    memoryDistillJobBroadcaster.publish({ type: 'distill.started', jobId: job.id })
    try {
      const result = await runDistill(job, siblings)  // see §5
      db.update(memoryDistillJobs).set({ status: 'done', finishedAt: Date.now() }).where(inArray(memoryDistillJobs.id, ids)).run()
      memoryDistillJobBroadcaster.publish({ type: 'distill.done', jobId: job.id, candidatesCreated: result.candidatesCreated })
    } catch (err) {
      const msg = String(err).slice(0, 2000)
      const attempts = job.attempts + 1
      const status = attempts >= 3 ? 'failed' : 'pending'
      const nextRunAt = attempts >= 3 ? job.nextRunAt : Date.now() + Math.pow(2, attempts) * 30_000
      db.update(memoryDistillJobs).set({ status, attempts, lastError: msg, nextRunAt }).where(inArray(memoryDistillJobs.id, ids)).run()
      memoryDistillJobBroadcaster.publish({ type: 'distill.failed', jobId: job.id, error: msg })
    }
  }
}
```

## 5. distiller 协议（核心）

### 5.1 总体形态

distiller 是一个**硬编码 system agent**，平台 spawn opencode subprocess 时通过 `OPENCODE_CONFIG_CONTENT` 注入。它不出现在 `agents` 表，不被用户编辑。

```ts
// services/memoryDistiller.ts
const DISTILLER_AGENT_NAME = 'aw-memory-distiller'
const DISTILLER_SYSTEM_PROMPT = `
You are aw-memory-distiller, an internal subsystem of the agent-workflow platform.

Your single task: read a batch of recent events (clarify Q&A, human review decisions, or task-feedback notes) and emit zero or more *candidate long-term memories* that future agents should learn from.

A good candidate memory:
- is a single, atomic, generalizable rule of thumb, decision, or preference — not a story.
- names a clear binding scope (one of: agent, workflow, repo, global).
- is written in plain English (regardless of the source language).
- is actionable for a future agent in similar situations.
- is at most ~400 characters.

A bad candidate (REJECT — emit nothing for it):
- is a fleeting status update, mood, or one-off acknowledgement.
- is a hallucination, restatement of the input verbatim, or pure paraphrase.
- has no clear scope it applies to.
- contradicts an existing approved memory without explicit reasoning.

You will be given:
- The events to process (each tagged with its source kind and ids).
- The list of currently-approved memories in each candidate scope (for dedup).
- The list of currently-used tags in each scope (for tag reuse).

For each candidate you emit, label its relation to existing memories using "action":
- "new"             — no existing memory addresses this.
- "update_of"       — refines / improves an existing memory; set referenceMemoryId.
- "duplicate_of"    — already covered; set referenceMemoryId. (Still emit so admin can see the duplicate signal.)
- "conflict_with"   — contradicts an existing memory; set referenceMemoryId.

Tag rules:
- Prefer existing tags exactly (case-sensitive lowercase-kebab).
- If you must introduce a new tag, list it in "newTags" not "knownTags". The admin decides whether to keep it.

Output exactly one <workflow-output> envelope with a single port "candidates" whose value is JSON matching this shape:

{
  "candidates": [
    {
      "scopeType": "agent" | "workflow" | "repo" | "global",
      "scopeId": "<id or null for global>",
      "title": "<= 120 chars",
      "bodyMd": "<= 400 chars, plain English",
      "knownTags": ["existing-tag", ...],
      "newTags": ["proposed-new-tag", ...],
      "action": "new" | "update_of" | "duplicate_of" | "conflict_with",
      "referenceMemoryId": "<id of related approved memory, or null>",
      "sourceRefs": [{"kind": "clarify" | "review" | "feedback", "id": "<event id>"}]
    }
  ]
}

If no good candidate exists, emit:
{"candidates": []}

Do NOT include any other narration outside the envelope. Do NOT call any tools.
`.trim()
```

### 5.2 调用流程

```ts
export async function runDistill(job: MemoryDistillJob, siblings: MemoryDistillJob[]): Promise<{ candidatesCreated: number }> {
  // 1. 拉所有 source events
  const eventsByKind = await loadSourceEvents(siblings)  // {clarify: [...], review: [...], feedback: [...]}

  // 2. 拉对应 scope 的现有 approved memory（用于 dedup）
  const scope = JSON.parse(job.scopeResolvedJson) as ResolvedScope
  const existingByScope = await loadExistingApprovedByScope(scope)
  const tagPoolByScope = await loadTagPoolByScope(scope)

  // 3. 拼 user prompt
  const userPrompt = buildDistillerUserPrompt({ events: eventsByKind, existingByScope, tagPoolByScope, taskId: job.taskId })

  // 4. spawn opencode subprocess with inline distiller agent
  const tmpDir = await mkdtemp(join(os.tmpdir(), 'aw-distiller-'))
  try {
    const cfg = {
      agent: {
        [DISTILLER_AGENT_NAME]: {
          prompt: DISTILLER_SYSTEM_PROMPT,
          model: getConfig().memoryDistillModel ?? getConfig().defaultModel,
          // no tools, no skills, no mcp — pure prompt
        },
      },
    }
    const env = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
      OPENCODE_CONFIG_DIR: tmpDir,
    }
    const result = await spawnOpencode({
      agent: DISTILLER_AGENT_NAME,
      prompt: userPrompt,
      cwd: tmpDir,    // CRITICAL: not the worktree (no git diff side effects)
      env,
      timeoutMs: 120_000,
    })

    // 5. parse envelope
    const candidates = parseDistillerOutput(result.stdout)

    // 6. validate + insert as status='candidate'
    let createdCount = 0
    for (const c of candidates) {
      try {
        const memory = validateAndPersistCandidate(c, job)
        memoryBroadcaster.publish({ type: 'memory.candidate.created', memory: toSummary(memory) })
        createdCount++
      } catch (validationErr) {
        // log + skip, don't fail the whole batch
        console.warn('[rfc041/distill-candidate-invalid]', validationErr)
      }
    }
    return { candidatesCreated: createdCount }
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
```

### 5.3 输出解析

复用现有 `packages/shared/src/envelope.ts::extractLastEnvelope`（RFC-023 已就绪）；解析 port "candidates" 为 JSON。zod 校验单条 candidate 形态：

```ts
const CandidateRawSchema = z.object({
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  title: z.string().min(1).max(120),
  bodyMd: z.string().min(1).max(400),
  knownTags: z.array(z.string()).max(16).default([]),
  newTags: z.array(z.string()).max(8).default([]),
  action: DistillActionSchema,
  referenceMemoryId: z.string().nullable().default(null),
  sourceRefs: z.array(z.object({ kind: z.enum(['clarify','review','feedback']), id: z.string() })),
})
```

非法 candidate 跳过 + 日志，不让一条坏 candidate 卡死整 batch。

## 6. 注入算法（runner 端）

### 6.1 入口

```ts
// services/runner.ts (现有函数 buildInlineAgentJson 中)
function buildInlineAgentJson(ctx: RunNodeContext, agentDef: AgentDef): string {
  let prompt = agentDef.bodyMd
  const block = formatMemoryBlock(loadInjectableMemories({ taskId: ctx.taskId, agentId: agentDef.id }))
  if (block) prompt = `${prompt}\n\n${block}`
  return JSON.stringify({ agent: { [agentDef.name]: { prompt, model: ctx.model, ... } } })
}
```

### 6.2 `loadInjectableMemories`

```ts
// services/memoryInject.ts
export function loadInjectableMemories(opts: { taskId: string; agentId: string }): InjectedMemorySet {
  const task = db.select().from(tasks).where(eq(tasks.id, opts.taskId)).get()
  if (!task) return { byScope: { agent: [], workflow: [], repo: [], global: [] } }
  const budget = getConfig().memoryInjectionBudget

  // agent scope = the node's agent + dependsOn 闭包（复用现有 agentClosure.ts）
  const closure = computeAgentClosure(opts.agentId)  // returns Set<string>
  const agentMems = db.select().from(memories).where(
    and(
      eq(memories.scopeType, 'agent'),
      inArray(memories.scopeId, [...closure]),
      eq(memories.status, 'approved'),
    ),
  ).orderBy(desc(memories.createdAt)).all()

  const workflowMems = task.workflowId ? db.select().from(memories).where(
    and(eq(memories.scopeType, 'workflow'), eq(memories.scopeId, task.workflowId), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all() : []

  const repoMems = task.repoId ? db.select().from(memories).where(
    and(eq(memories.scopeType, 'repo'), eq(memories.scopeId, task.repoId), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all() : []

  const globalMems = db.select().from(memories).where(
    and(eq(memories.scopeType, 'global'), eq(memories.status, 'approved')),
  ).orderBy(desc(memories.createdAt)).all()

  return {
    byScope: {
      agent: clipByBudget(agentMems, budget.agent),
      workflow: clipByBudget(workflowMems, budget.workflow),
      repo: clipByBudget(repoMems, budget.repo),
      global: clipByBudget(globalMems, budget.global),
    },
  }
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)  // rough heuristic; future: real tokenizer
}

function clipByBudget(rows: Memory[], budgetTokens: number): Memory[] {
  const out: Memory[] = []
  let used = 0
  for (const r of rows) {
    const cost = estimateTokens(`- [${r.scopeType}] ${r.title} — ${r.bodyMd}\n`)
    if (used + cost > budgetTokens) break
    out.push(r)
    used += cost
  }
  return out
}
```

### 6.3 `formatMemoryBlock`

```ts
export function formatMemoryBlock(set: InjectedMemorySet): string | null {
  const all = [...set.byScope.agent, ...set.byScope.workflow, ...set.byScope.repo, ...set.byScope.global]
  if (all.length === 0) return null
  const lines = all.map(m => `- [${m.scopeType}] ${m.title} — ${m.bodyMd}`)
  return [
    '## Learned context (auto-injected, advisory)',
    '',
    'The following items were distilled from past sessions and approved by an administrator. Treat them as soft preferences — they may not all apply to your current task. Use judgment; do not cite them as authoritative instructions.',
    '',
    '--- BEGIN INJECTED MEMORY ---',
    ...lines,
    '--- END INJECTED MEMORY ---',
  ].join('\n')
}
```

### 6.4 关键约束（grep 守卫）

- `runner.ts` 必须含 `formatMemoryBlock(` 调用 —— 防回归。
- `formatMemoryBlock` 必须含 `BEGIN INJECTED MEMORY` / `END INJECTED MEMORY` 包围符 —— 防文案漂移。
- `memoryDistiller.ts` 必须含 `OPENCODE_CONFIG_CONTENT` 关键字 —— 防绕过 opencode runtime 改走他路。
- `memoryDistiller.ts` 必须含 `mkdtemp` / `os.tmpdir()` —— 防 cwd 误用为 worktree（会产生意外 git diff）。

## 7. REST 接口

### 7.1 路由列表

| Method | Path | 权限 | 说明 |
|---|---|---|---|
| GET    | `/api/memories` | `memory:read` | 分页列表，filter: status / scopeType / scopeId / search(title contains) / tag |
| GET    | `/api/memories/:id` | `memory:read` | 详情 + supersede 链 |
| POST   | `/api/memories/:id/promote` | `memory:approve` | body 见 `MemoryCandidatePromoteSchema` |
| POST   | `/api/memories/:id/archive` | `memory:archive` | 状态转 archived |
| POST   | `/api/memories/:id/unarchive` | `memory:archive` | archived → approved |
| DELETE | `/api/memories/:id?confirm=true` | `memory:delete` | hard delete；无 confirm=true → 400 |
| GET    | `/api/memory-distill-jobs` | `memory:approve`（admin） | filter: status |
| POST   | `/api/memory-distill-jobs/:id/retry` | `memory:approve` | 仅 failed → pending |
| POST   | `/api/memory-distill-jobs/:id/cancel` | `memory:approve` | pending → canceled |
| GET    | `/api/tasks/:taskId/feedback` | task 可见者（RFC-036） | 列表 |
| POST   | `/api/tasks/:taskId/feedback` | task 可见者 + `memory:write_feedback` | 提交留言 |

### 7.2 PERMISSIONS 字面量新增（接 RFC-036）

```ts
// auth/permissions.ts
export const PERMISSIONS = {
  // ...existing...
  MEMORY_READ:         'memory:read',
  MEMORY_APPROVE:      'memory:approve',
  MEMORY_ARCHIVE:      'memory:archive',
  MEMORY_DELETE:       'memory:delete',
  MEMORY_WRITE_FEEDBACK: 'memory:write_feedback',
} as const

export const ROLE_PERMISSIONS: Record<UserRole, Set<string>> = {
  admin: new Set([..., MEMORY_READ, MEMORY_APPROVE, MEMORY_ARCHIVE, MEMORY_DELETE, MEMORY_WRITE_FEEDBACK]),
  user:  new Set([..., MEMORY_READ, MEMORY_WRITE_FEEDBACK]),
}
```

### 7.3 promote 接口语义

```ts
// services/memory.ts
export async function promoteCandidate(memoryId: string, body: MemoryCandidatePromote, adminUserId: string) {
  return db.transaction(async tx => {
    const cand = tx.select().from(memories).where(eq(memories.id, memoryId)).get()
    if (!cand) throw new HTTPException(404)
    if (cand.status !== 'candidate') throw new HTTPException(409, 'not a candidate')

    if (body.action === 'reject') {
      tx.update(memories).set({ status: 'rejected' }).where(eq(memories.id, memoryId)).run()
      memoryBroadcaster.publish({ type: 'memory.candidate.promoted', memoryId, newStatus: 'rejected' })
      return
    }

    // approve / approve_and_supersede
    const supersedeIds = body.action === 'approve_and_supersede' ? body.supersedeIds : []
    if (supersedeIds.length > 0) {
      const targets = tx.select().from(memories).where(inArray(memories.id, supersedeIds)).all()
      for (const t of targets) {
        if (t.status !== 'approved') throw new HTTPException(409, `cannot supersede non-approved memory ${t.id}`)
        if (t.scopeType !== cand.scopeType || t.scopeId !== cand.scopeId) throw new HTTPException(409, 'scope mismatch')
      }
      const maxVersion = Math.max(...targets.map(t => t.version))
      tx.update(memories)
        .set({
          status: 'approved',
          approvedByUserId: adminUserId,
          approvedAt: Date.now(),
          version: maxVersion + 1,
          supersedesId: supersedeIds[0],
          tags: JSON.stringify(body.tagsOverride ?? JSON.parse(cand.tags)),
        })
        .where(eq(memories.id, memoryId))
        .run()
      tx.update(memories)
        .set({ status: 'superseded', supersededById: memoryId })
        .where(inArray(memories.id, supersedeIds))
        .run()
      memoryBroadcaster.publish({ type: 'memory.candidate.promoted', memoryId, newStatus: 'approved', supersededIds: supersedeIds })
      for (const sid of supersedeIds) memoryBroadcaster.publish({ type: 'memory.superseded', oldId: sid, newId: memoryId })
    } else {
      tx.update(memories)
        .set({
          status: 'approved',
          approvedByUserId: adminUserId,
          approvedAt: Date.now(),
          tags: JSON.stringify(body.tagsOverride ?? JSON.parse(cand.tags)),
        })
        .where(eq(memories.id, memoryId))
        .run()
      memoryBroadcaster.publish({ type: 'memory.candidate.promoted', memoryId, newStatus: 'approved' })
    }
  })
}
```

## 8. WS 通道

新增两个 broadcaster（接 `ws/broadcaster.ts` 既有模式）：

```ts
export const MEMORY_CHANNEL = '/ws/memories'
export const MEMORY_DISTILL_JOB_CHANNEL = '/ws/memory-distill-jobs'

export const memoryBroadcaster = createBroadcaster<MemoryWsMessage>(MEMORY_CHANNEL)
export const memoryDistillJobBroadcaster = createBroadcaster<MemoryDistillJobWsMessage>(MEMORY_DISTILL_JOB_CHANNEL)
```

Server 端在 `server.ts` 加 ws upgrade endpoint，复用 `auth/wsAuth.ts` 现有鉴权。

`/ws/memory-distill-jobs` 仅 admin（按 PERMISSIONS.MEMORY_APPROVE 鉴权）；`/ws/memories` 任何 logged-in。

## 9. 前端组件

### 9.1 顶栏接入

`routes/__root.tsx`（或 `components/shell/AppShell.tsx`）的 nav array 加：

```tsx
{ to: '/memory', label: t('nav.memory'), hint: t('nav.memoryHint'), icon: <BrainIcon /> }
```

接 RFC-032 已有的 `<TopNav>` 组件，admin 时 nav 项右上角 badge 显示 pending candidate 数（来自 `useMemoryWs` 推送 + 初始 `GET /api/memories?status=candidate&pageSize=0` 拉总数）。

### 9.2 路由 + 子路由

```
src/routes/memory.tsx            ← layout，左侧二级 tab
src/routes/memory/index.tsx      ← redirect to approval-queue
src/routes/memory/approval-queue.tsx   ← admin only, 普通用户重定向 /memory/all
src/routes/memory/all.tsx
src/routes/memory/by-scope.tsx
src/routes/memory/distill-jobs.tsx     ← admin only
```

### 9.3 主要新组件

- `<MemoryApprovalQueue />` —— admin 审批主界面：每行 candidate 显示 title / body / tags / scope chip / sourceRefs 链接 / distillAction badge / [Approve] [Supersede] [Reject] 按钮组。
- `<MemoryConflictCompareDialog />` —— action=conflict_with 时点 [Compare] 弹窗，并排展示 ref memory vs candidate。
- `<MemoryRow />` —— 通用一行渲染（all / by-scope 复用）。
- `<MemoryScopedList scopeType scopeId />` —— 嵌入 agent / workflow / repo / user detail 页的 "Memories" sub-tab。
- `<MemoryDistillJobsTable />` —— admin 监控页；行级 retry / cancel。
- `<TaskFeedbackList taskId />` —— 任务详情页底部留言区，复用 RFC-035 `<EmptyState>` / `<LoadingState>` 共享组件。

### 9.4 Inbox drawer 集成

`InboxDrawer.tsx` 加第三个 group（RFC-032 的 inbox 已有 clarify / review 两 group）：

```tsx
{isAdmin && (
  <InboxGroup
    title={t('inbox.pendingMemory')}
    items={pendingMemories}
    renderItem={(m) => <MemoryInboxRow memory={m} />}
  />
)}
```

`useMemoryWs` hook 监听 `/ws/memories`，新 candidate 时 invalidate `['memories', 'candidate']` query。

### 9.5 任务详情页接入

`routes/tasks/$taskId.tsx`（或类似）在底部 mount `<TaskFeedbackList taskId={taskId} />`，位置：在 node-runs 表之后、debug 区之前。

### 9.6 Agent / Workflow / Repo 详情页

各 detail 页（已有 RFC-035 `<DetailLayout>` 结构）加一个 sub-tab "Memories"：

```tsx
<DetailLayout
  tabs={[..., { key: 'memories', label: t('detail.memories'), content: <MemoryScopedList scopeType="agent" scopeId={agent.id} /> }]}
/>
```

仅在 logged-in 且该 scope 下有 ≥ 1 approved memory 时高亮 tab；为 0 时 tab 仍存在但显示 EmptyState（"No learned context yet"）。

## 10. i18n key 增量（中英对称，约 32 key）

```ts
// 中英都加：
nav.memory                     = "Memory" / "记忆"
nav.memoryHint                 = "Distilled long-term context from past clarify, review, and feedback" / "从过往反问、评审和反馈中沉淀的长期上下文"
memory.tab.approvalQueue       = "Approval Queue" / "审批队列"
memory.tab.all                 = "All Approved" / "已审批"
memory.tab.byScope             = "By Scope" / "按维度"
memory.tab.distillJobs         = "Distill Jobs" / "提炼任务"
memory.action.approve          = "Approve" / "批准"
memory.action.approveSupersede = "Approve & supersede…" / "批准并覆盖…"
memory.action.reject           = "Reject" / "驳回"
memory.action.archive          = "Archive" / "归档"
memory.action.unarchive        = "Unarchive" / "取消归档"
memory.action.delete           = "Delete" / "删除"
memory.confirmDelete           = "Permanently delete this memory? This cannot be undone." / "永久删除此记忆?不可恢复。"
memory.candidate.from          = "From {{kind}} {{id}}" / "来自 {{kind}} {{id}}"
memory.distillAction.new       = "New" / "新增"
memory.distillAction.updateOf  = "Updates {{id}}" / "更新自 {{id}}"
memory.distillAction.duplicateOf = "Duplicate of {{id}}" / "重复于 {{id}}"
memory.distillAction.conflictWith = "Conflicts with {{id}}" / "与 {{id}} 冲突"
memory.scope.agent             = "Agent" / "Agent"
memory.scope.workflow          = "Workflow" / "工作流"
memory.scope.repo              = "Repo" / "仓库"
memory.scope.global            = "Global" / "全局"
memory.status.candidate        = "Candidate" / "候选"
memory.status.approved         = "Approved" / "已批准"
memory.status.archived         = "Archived" / "已归档"
memory.status.superseded       = "Superseded" / "已覆盖"
memory.status.rejected         = "Rejected" / "已驳回"
memory.empty                   = "No learned context yet" / "暂无沉淀"
memory.adminOnly               = "Admin only" / "仅管理员"
inbox.pendingMemory            = "Pending memory ({{count}})" / "待审批记忆 ({{count}})"
tasks.feedback.placeholder     = "Leave a note for future runs of this workflow…" / "给本工作流未来运行的我们留一句话…"
tasks.feedback.submit          = "Save note" / "保存留言"
tasks.feedback.empty           = "No feedback yet" / "暂无留言"
tasks.feedback.distilled       = "Sent to distiller" / "已交付提炼"
detail.memories                = "Memories" / "记忆"
distillJob.status.pending      = "Pending" / "等待"
distillJob.status.running      = "Running" / "运行中"
distillJob.status.done         = "Done" / "完成"
distillJob.status.failed       = "Failed" / "失败"
distillJob.action.retry        = "Retry" / "重试"
distillJob.action.cancel       = "Cancel" / "取消"
```

`i18n-keys-symmetry.test.ts` 自动锁。

## 11. 失败模式 / 边界

| 场景 | 框架反应 |
|---|---|
| distiller subprocess 超时（120s 未结束） | spawn 进程 SIGTERM；attempts++；exp backoff |
| distiller stdout 无 envelope | parse 抛错；attempts++；exp backoff（避免给 admin 报噪声："empty distill result"也算失败） |
| distiller stdout envelope 内 JSON 不合法 | parse 抛错；同上 |
| distiller 输出某 candidate scope_id 不存在（agent 已删） | 该 candidate 校验失败跳过；其它正常落库；job 仍标 done |
| distiller 输出 supersede 引用一个 candidate 状态的 memory | candidate referenceMemoryId 字段允许指向任何状态 memory；promote 时若 supersede target 非 approved 则 409 |
| 同 debounce_key 两个 pending 中间被一个 admin 手动 promote | promote 不影响 distiller；下次 distill 时 dedup 输入会读到新 approved，自然产出 update_of |
| admin 审批同时 archive 同一 memory | DB 行级 transaction 保护；后到者拿到旧 row.status='approved'（事务读快照），promote 会发现 status 不匹配 → 409 |
| daemon 重启时 running job | startup hook 全转回 pending；下次 tick 拾起；attempts 不递增（区别于真实失败） |
| memoryDistillerEnabled=false | enqueueDistillJob 仍写表（保留 audit），但 worker tick 不取（双闸；admin 切回 enabled 时积压全部 drain） |
| 任务删除（hard delete tasks 行） | task_feedback 行保留（不级联）；memory_distill_jobs 中 taskId 变孤儿但 scope_resolved 已固化在 job 上，照常运行 |
| repo 删除 | scope_id 指向那个 repoId 的 memory 行保留；inject 时该 repo_id 不再被任何 task 路由到，自然过期；admin 可手动 archive 批量清理（非 MVP） |
| inject 时 agent_id 闭包包含已删 agent | inArray 自然不返回；零异常 |
| inject 时 budget = 0 | clipByBudget 直接返空；block 不出现 |
| 多 tab admin 并发 promote 同 candidate | promote 函数事务读 status='candidate'；后到者 409 |

## 12. opencode 行为验证（按 CLAUDE.md 强制规则）

本 RFC 仅依赖 opencode 既有两个机制：

1. **`OPENCODE_CONFIG_CONTENT` inline JSON 合并** —— `packages/opencode/src/config/config.ts:641`（已在 RFC-029 / RFC-031 验证）：opencode 启动时把环境变量里的 JSON 作为最高优先级合并到 config，inline 定义的 agent 凌驾于任何 dir 扫描的同名 agent。distiller 用的 `aw-memory-distiller` 是平台保留前缀，正常不会与用户 agent 同名；即便重名，inline 也胜出。
2. **`<workflow-output>` envelope** —— `packages/opencode/src/...`（RFC-023 已验证）：opencode 透传 stdout，框架侧用 `extractLastEnvelope` 取末尾 envelope。distiller subprocess 同样走这条协议，零特殊处理。

**不依赖 / 不改动 opencode** 的部分：tool 注册（distiller agent 配置无 tools）、skill 加载（无 skills）、mcp 配置（无 mcp）、plugin 加载（无 plugin）。distiller 是一个最小化纯 prompt agent。

## 13. 测试策略

按 CLAUDE.md "Test-with-every-change"：每个改动都带测试，并写明 grep guard。

### 13.1 shared（≈ 20 case）

- `packages/shared/tests/memory-schema.test.ts`：MemorySchema 边界（全 4 scope × scopeId null/非 null × status × tag 数 0/1/16/17 越界 × body 长度 0/1/4000/4001）。
- `packages/shared/tests/memory-promote-schema.test.ts`：3 个 action 各正负样本 + 错误 union 拒绝。
- `packages/shared/tests/task-feedback-schema.test.ts`：body trim / 0/1/4000/4001。
- `packages/shared/tests/memory-ws-schema.test.ts`：4 个 memory ws msg + 4 个 distill job ws msg discriminated union 边界。

### 13.2 backend（≈ 50 case）

- `migration-0023.test.ts`：3 表存在、CHECK 约束生效（global+scopeId 非 null 写入失败、非 global+scopeId NULL 写入失败）、索引存在（`PRAGMA index_list`）。
- `memory-distiller.test.ts`：mock spawnOpencode 返固定 envelope，断言 candidates 入表、distillAction 持久化、dedup 输入含 existing memories、tagPool 含已用 tags。包含 8 case：正常 / 空 envelope / malformed JSON / candidate scope 不存在 / candidate body 超长 / sourceRefs 缺失 / cwd=tmpDir 守卫 / OPENCODE_CONFIG_CONTENT env 守卫。
- `memory-distill-scheduler.test.ts`：enqueueDistillJob 3 case（clarify / review / feedback debounce_key 正确）+ debounce 合并（同 key 3 个 pending → 单次 distill 消费）+ exp backoff（attempt 1→ +60s / 2→ +120s / 3 → failed）+ shutdown recovery（running → pending）。
- `memory-promote.test.ts`：approve / approve_and_supersede 单 target / approve_and_supersede 多 target / reject / scope mismatch 409 / supersede target 非 approved 409 / 并发 promote 同一 candidate 409。
- `memory-inject.test.ts`：4 scope 同时 active 时 budget 切片 / 0 approved 时返 null block / agent closure 闭包正确拉所有 dependsOn agent / disabled scope 不出现 / repo 删 → 该 scope 行返空 / `formatMemoryBlock` 输出 BEGIN/END 包围 grep guard / `runner.ts` 必含 `formatMemoryBlock(` grep guard / superseded memory 不被注入。
- `routes-memory.test.ts`：4 个 admin-only 接口 403 非 admin / 200 admin / 400 缺 confirm=true / 200 任意 user GET list / 跨 scope filter 正确。
- `routes-task-feedback.test.ts`：POST 写成功 enqueue distill / GET task 可见性闭包 / 非 collaborator 403。
- `daemon-distill-loop.test.ts`：tick 行为整体（mock Date.now + 注入 jobs，断言 status 翻转）。

### 13.3 frontend（≈ 22 case）

- `task-feedback-list.test.tsx`（6）：渲染列表 / 提交 submit 触发 POST / 3s rate-limit / WS 推送追加新行 / 空 EmptyState / 提交失败 toast。
- `memory-approval-queue.test.tsx`（5）：admin 看到按钮 / 非 admin 按钮 disabled / Approve 按钮 click → POST / Reject 按钮 → POST reject / Supersede 打开 dialog。
- `memory-conflict-compare-dialog.test.tsx`（3）：并排 diff 渲染 / Approve & supersede 提交 / Reject 关闭。
- `memory-scoped-list.test.tsx`（3）：agent / workflow / repo scope 各拉对应 endpoint / 空 EmptyState。
- `nav-memory-tab.test.tsx`（3）：顶栏渲染含 Memory 项 / admin badge 显示 N / 非 admin 不显示 badge。
- `i18n-keys-symmetry.test.ts`：自动套用，断言 32 新 key 中英对称。
- `lib-memory.test.ts`（5）：纯函数 `promoteActionToLabel` / `groupCandidatesByScope` / `formatMemoryRow` 等。

### 13.4 e2e（1 spec）

`e2e/tests/memory.spec.ts`：
1. seed 一个 admin user + 一个普通 user + 一个 agent + 一个 workflow + 一个 repo。
2. 用普通 user 启动 task / 答 clarify（stub-opencode 触发 clarify envelope）。
3. clarify session completed → enqueue distill job → wait 6s（debounce 5s + 1s margin） → stub-opencode-memory-distiller.sh 被 spawn，echo 一个固定 candidate 到 stdout（带 `<workflow-output>`）。
4. 切到 admin user → 顶栏看到 Memory tab + badge=1 → 进 approval queue → 点 Approve。
5. admin 启动一个新 task on 同 workflow → stub-opencode-runner.sh 检查接收到的 inline JSON 含 `--- BEGIN INJECTED MEMORY ---` + candidate body 文本。

stub-opencode-memory-distiller.sh 长这样：

```sh
#!/usr/bin/env bash
cat <<EOF
<workflow-output>
<port name="candidates">
{"candidates":[{
  "scopeType":"workflow","scopeId":"$WF_ID",
  "title":"E2E test: prefer plural for collections",
  "bodyMd":"When generating a list endpoint, name it /items not /item.",
  "knownTags":[],"newTags":["e2e-tag"],
  "action":"new","referenceMemoryId":null,
  "sourceRefs":[{"kind":"clarify","id":"$CLARIFY_ID"}]
}]}
</port>
</workflow-output>
EOF
```

### 13.5 三件套门槛

`bun run typecheck && bun run test && bun run format:check` 全绿；GitHub Actions 六 jobs 全绿。

## 14. 回滚方案

- migration 0023 是新增表，drop 安全；本 RFC 提供 down 脚本（按 CLAUDE.md，本仓的 migration 历史保留 down 段落）。
- 整 RFC 由多 PR 拼成（见 plan.md），任一 PR 可独立 revert；前后兼容点：
  - 仅 P1 落地（schema + 空 distiller + 仅手动入 candidate）→ 系统功能可用，runtime 无 inject（formatMemoryBlock 返 null）。
  - P1+P2 落地（信号入队）→ candidate 自动产出，但 runtime 仍无 inject；admin 可审批。
  - P1+P2+P3 落地（inject）→ 完整闭环。
- 回滚顺序：先回 P3（关 inject），再回 P2（关 distiller），最后回 P1（drop tables）。中间任意停留态下系统都能跑。

## 15. 安全 / 隐私

- distiller cwd 强制 OS temp dir，不接触 worktree —— 不会产生意外 git diff，不会读用户私有源码（distiller 只读 clarify Q&A / review comment / feedback 文本，不读 task workflow 输入）。
- distiller subprocess 用 `process.env` 副本 + 覆盖 `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR`，不传 secret env（CLAUDE.md 已有 sandbox 模式遵循 minimal-env 原则；本 RFC 复用既有 sandbox 工具函数）。
- memory.body_md 在 inject 时直接进 system prompt，agent 可见；admin 审批责任 = 防止把敏感信息（密钥 / 内部命名）放入 memory；UI 上 approve 按钮旁加一行 hint "Approved memories are injected into every agent run in the matching scope. Do not include secrets."
- task_feedback 内容可被 distiller 读 → 后续可能 inject。前端 placeholder 写明 "Do not include secrets, they may be visible to all admins and future agent runs."

## 16. 性能预算

- 入队成本：每个 clarify/review/feedback event 增加 1 次 DB insert + 1 次 WS publish ≈ < 5ms。
- daemon worker：1Hz 轮询；空载查询 `WHERE status='pending' AND next_run_at <= now LIMIT 5` 走索引 ≈ < 1ms。
- distiller subprocess：单次 opencode spawn ~ 100ms 启动 + LLM ~ 5-30s + 进程退出 ~ 50ms。debounce + 合并控制了同 task 同 source 5s 内至多触发 1 次。
- inject 成本：每次 runNode 4 次 SELECT（4 scope）≈ < 5ms（全部走 `idx_memories_scope_status`）；budget clip 是 O(N) 字符串拼接，N << 100。

## 17. 与 design/design.md 的关系

本 RFC 内容**不写进** `design/design.md`（那是 v0.1 总体设计文档；RFC 落地后只在功能稳定时回写一两段总结）。在 RFC 完工 / push 后，`design/plan.md` 的 RFC 索引表更新状态 → Done，`STATE.md` 顶部"进行中 RFC"段移除。
