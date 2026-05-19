# RFC-043 — 技术设计

## 1. 改动地图

| 层 | 路径 | 改动 |
|---|---|---|
| DB migration | `packages/backend/db/migrations/0024_rfc043_distill_capture.sql`（新） | `memory_distill_jobs` 加 5 列；新 `memory_distill_events` 表 |
| schema | `packages/backend/src/db/schema.ts` | 同步 5 新列 + 新表 |
| shared schemas | `packages/shared/src/schemas/memory.ts` | `MemoryDistillJobSchema` 加新字段；新 `MemoryDistillJobDetailSchema`、`MemoryDistillEventSchema`、`MemoryDistillSessionViewSchema`、`MemoryDistillCandidateSnapshotSchema` |
| backend service | `packages/backend/src/services/memoryDistiller.ts` | `runDistill` 抓 sessionId、stderr/exit、user_prompt、dedup_snapshot_ids 落到 job 行；调 `captureDistillJobSession` |
| backend service | `packages/backend/src/services/distillSessionCapture.ts`（新） | 薄包装 `sessionCapture` 的 `captureChildSessions` 同款 BFS + transcode 路径，目标表换成 `memory_distill_events`，owner 字段是 jobId/attemptIndex |
| backend service | `packages/backend/src/services/memoryDistillJobDetail.ts`（新） | `getDistillJobDetail(jobId)` 把 job + siblings + sourceEvents + dedupSnapshot + candidates 一次性聚合 |
| backend routes | `packages/backend/src/routes/memoryDistillJobs.ts`（既有，扩展） | 新 2 个 admin 端点：`GET /api/memory/distill-jobs/:jobId`、`GET /api/memory/distill-jobs/:jobId/session` |
| frontend routes | `packages/frontend/src/routes/memory.distill-jobs.$jobId.tsx`（新） | 顶层路由 |
| frontend components | `packages/frontend/src/components/memory/distill-job-detail/` 6 新组件 | DetailHeader / SourceEventsList / ScopeAndDedupSnapshot / CandidatesList / FailureDiagnostics / ConversationSection（复用 ConversationFlow + attempt picker） |
| frontend lib | `packages/frontend/src/lib/distill-job-detail.ts`（新） | 纯函数：`groupSourceEventsByKind` / `formatExitCode` / `truncateStderr` / `selectAttempts` / `sessionEventsToTree` 适配器 |
| frontend table 改造 | `packages/frontend/src/components/memory/MemoryDistillJobsTable.tsx` | 行整行点击跳详情；retry/cancel 按钮 `e.stopPropagation()` |
| WS | `packages/backend/src/ws/server.ts` | 不新增 channel；详情页订阅复用 `/ws/memory-distill-jobs` 拉 invalidate |
| i18n | `packages/frontend/src/i18n/{en-US,zh-CN}.ts` | 新增 ~22 key（`memory.distillJobDetail.*`），中英对称 |
| styles | `packages/frontend/src/styles.css` | `.distill-job-detail` 命名空间 ~30 选择器，复用 RFC-035 design tokens |

**零改动清单**：opencode 源码；workflow YAML / agent frontmatter；RFC-027 sessionCapture 主路径；
RFC-041 Approval Queue / candidate inject 逻辑；RFC-039 / RFC-040 / RFC-042 文案与协议。

## 2. DB 扩展（migration 0024）

```sql
-- 1) memory_distill_jobs 加 5 列（全部 NULL 兼容老 job 行）
ALTER TABLE memory_distill_jobs ADD COLUMN opencode_session_id TEXT;
ALTER TABLE memory_distill_jobs ADD COLUMN user_prompt_md     TEXT;
ALTER TABLE memory_distill_jobs ADD COLUMN exit_code          INTEGER;
ALTER TABLE memory_distill_jobs ADD COLUMN stderr_excerpt     TEXT;
ALTER TABLE memory_distill_jobs ADD COLUMN dedup_snapshot_ids_json TEXT;

-- 2) memory_distill_events 镜像 node_run_events 形态
CREATE TABLE memory_distill_events (
  id                BLOB    PRIMARY KEY,         -- ULID
  distill_job_id    TEXT    NOT NULL REFERENCES memory_distill_jobs(id) ON DELETE CASCADE,
  attempt_index     INTEGER NOT NULL,            -- 0..N-1 对齐 attempts 计数
  session_id        TEXT    NOT NULL,            -- opencode session id（含 BFS 拿到的 child）
  parent_session_id TEXT,
  ts                INTEGER NOT NULL,
  kind              TEXT    NOT NULL,            -- 与 node_run_events 同 kind 集合
  payload_json      TEXT    NOT NULL
);
CREATE INDEX idx_distill_events_job_attempt ON memory_distill_events(distill_job_id, attempt_index, ts);
CREATE INDEX idx_distill_events_session    ON memory_distill_events(session_id, ts);
```

**为什么是新表而不是复用 `node_run_events`**：
- `node_run_events.node_run_id` 是非空外键 → `node_runs(id)`；强行塞 distill job 行得加 nullable +
  另一个 ownerKind 字段，会污染 hot path。
- distill job 没有 retry_index / shard_key 这些 node_run 概念，schema 不对齐。
- 新表外键 CASCADE 到 `memory_distill_jobs`，job 行被清理时事件自动消失。

**新列字段含义**：
- `opencode_session_id`：从 distiller subprocess 的 stderr 抓的（opencode CLI 启动时 stderr
  会打 `Session id: <id>`，runner 现有 `extractSessionIdFromStderr` 已有），attempt 重试时被新值
  覆盖（详情页通过 events 表 `attempt_index` 区分历史 session）。
- `user_prompt_md`：本次组装喂给 distiller 的完整 user prompt（含 events + dedup snapshot + tag
  pool），跑前一次性写入；attempt 间会变（dedup 上下文随时间变化）→ 同样存"最新一次"，历史
  attempts 的 prompt 通过 events 表里第一条 user message kind 还原。
- `exit_code` / `stderr_excerpt`：每次 spawn 完写入（成功也写，便于审计）。stderr 经 `clipAndRedact`
  截断到 2KB + redact secrets。
- `dedup_snapshot_ids_json`：`{ snapshot: [{ memoryId, scopeType, scopeId, title }] }` 当时被
  载入给 distiller 看的 approved memories 完整列表（不仅是 id，而是渲染所需的最小列），免得
  详情页需要再 join memories 表（且老 memory 可能已被 archive / superseded）。

## 3. shared schema 扩展

```ts
// memory.ts 追加
export const MemoryDistillEventSchema = z.object({
  id: z.string(),
  attemptIndex: z.number().int().min(0),
  sessionId: z.string(),
  parentSessionId: z.string().nullable(),
  ts: z.number().int(),
  kind: z.string(),
  payload: z.unknown(), // payload_json 解析后透传给 ConversationFlow
})
export type MemoryDistillEvent = z.infer<typeof MemoryDistillEventSchema>

export const MemoryDistillSessionViewSchema = z.object({
  attempts: z.array(z.object({
    attemptIndex: z.number().int(),
    rootSessionId: z.string().nullable(),
    tree: z.unknown(), // 复用 RFC-027 SessionViewResponse.tree 形态
    startedAt: z.number().int().nullable(),
    finishedAt: z.number().int().nullable(),
    exitCode: z.number().int().nullable(),
  })),
})

export const MemoryDistillCandidateSnapshotSchema = z.object({
  memoryId: z.string(),
  title: z.string(),
  bodyMd: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  distillAction: DistillActionSchema, // RFC-041 既有：new / update_of / duplicate_of / conflict_with
  currentStatus: MemoryStatusSchema,  // 详情页拉的时点 status，可能已 approve / archive
  referenceMemoryId: z.string().nullable(),
})

export const MemoryDistillJobDetailSchema = z.object({
  job: MemoryDistillJobSchema.extend({
    opencodeSessionId: z.string().nullable(),
    userPromptMd: z.string().nullable(),
    exitCode: z.number().int().nullable(),
    stderrExcerpt: z.string().nullable(),
  }),
  siblings: z.array(MemoryDistillJobSchema), // 同 debounce_key 被合并进来的 jobs
  sourceEvents: z.array(z.object({
    kind: z.enum(['clarify', 'review', 'feedback']),
    id: z.string(),
    summary: z.string(), // 一句话摘要：clarify question text / review title / feedback body 截断
    deepLink: z.string(), // 前端 router path
    deletedOrMissing: z.boolean(), // true → 不渲染链接，灰显
  })),
  dedupSnapshot: z.array(z.object({
    memoryId: z.string(),
    scopeType: MemoryScopeSchema,
    scopeId: z.string().nullable(),
    title: z.string(),
  })),
  candidates: z.array(MemoryDistillCandidateSnapshotSchema),
})
```

## 4. distiller 改动（捕获路径）

### 4.1 `runDistill` 的最小侵入

```ts
// memoryDistiller.ts diff（关键段）
export async function runDistill(options: RunDistillOptions): Promise<DistillResult> {
  // ... 既有 prompt / scopeContexts 组装 ...

  // ★ 1. 在 spawn 前把 user prompt + dedup snapshot 写到 job 行（便于详情页即使
  //     spawn 失败也能看 prompt）。仅当 job.attempts === 0 时写一次；attempt > 0
  //     的 prompt 由 events 表里第一条 message 还原。
  if (options.job.attempts === 0) {
    db.update(memoryDistillJobs).set({
      userPromptMd: userPrompt,
      dedupSnapshotIdsJson: JSON.stringify({ snapshot: buildDedupSnapshotForPersist(scopeContexts) }),
    }).where(eq(memoryDistillJobs.id, options.job.id)).run()
  }

  // ... spawn ...
  result = await spawnFn(...)

  // ★ 2. spawn 完立刻把 exitCode / stderr / sessionId 落库
  const sessionId = extractSessionIdFromStderr(result.stderr) // 复用 runner 同名 helper
  db.update(memoryDistillJobs).set({
    opencodeSessionId: sessionId ?? null,
    exitCode: result.exitCode ?? null,
    stderrExcerpt: clipAndRedact(result.stderr, 2048),
  }).where(eq(memoryDistillJobs.id, options.job.id)).run()

  // ★ 3. parse candidates 之后（无论成败），如果有 sessionId → 跑 capture
  if (sessionId !== null) {
    await captureDistillJobSession({
      db,
      distillJobId: options.job.id,
      attemptIndex: options.job.attempts, // 当前是第几次 attempt
      rootSessionId: sessionId,
      log: options.log,
    }).catch((err) => {
      options.log?.warn?.('rfc043/distill-capture-failed', { jobId: options.job.id, err: String(err) })
    })
  }

  // ... 既有 throw if exitCode !== 0 ...
}
```

### 4.2 `distillSessionCapture.ts`

```ts
// 90% 是 sessionCapture.ts 的 captureChildSessions 复制粘贴，差异：
//   - 不查 sibling node_runs（distill job 无 node_run / shard / retry 概念）
//   - 插入目标表是 memory_distill_events，行带 attemptIndex
//   - 失败 marker kind = 'rfc043/distill-capture-failed'，写一条 payload 为
//     { reason, distillJobId, attemptIndex } 的 marker 行（便于详情页显示
//     "捕获失败，但 prompt + exitCode + stderr 仍可看"）

export async function captureDistillJobSession(opts: {
  db: Db
  distillJobId: string
  attemptIndex: number
  rootSessionId: string
  opencodeDbPath?: string // 测试注入
  log?: Logger
}): Promise<{ insertedRows: number; failed: boolean; failureReason: string | null }> {
  // BFS opencode SQLite 子 session → transcode → insert，主流程见 sessionCapture.ts:175
  // ...
}
```

**为什么不抽通用 owner-agnostic capture**：sessionCapture 的"sibling dedup"逻辑（一个 task 内多个
node_run 共享 sessionId 跳过重复）对 distill 不适用，但对 node 是核心；硬抽通用接口会让 node 路径
变复杂。RFC-043 选小代码量的 90% 复制路径，等 future 真的有第三类 owner 再做抽象。

### 4.3 失败路径不阻塞 capture

`runDistill` 现行逻辑里 `exitCode !== 0` 直接抛错。本 RFC 把 capture 移到 throw 之前，让失败
job 的 stderr / sessionId / capture 行也能落库。事件捕获即使失败也 swallow（log warn），不影响
原有 distill 失败传播（外层 scheduler tick 仍会按 exitCode 失败计 attempts）。

## 5. backend 服务 & 接口

### 5.1 `memoryDistillJobDetail.ts`

```ts
export async function getDistillJobDetail(db: Db, jobId: string): Promise<MemoryDistillJobDetail> {
  const jobRow = db.select().from(memoryDistillJobs).where(eq(memoryDistillJobs.id, jobId)).get()
  if (!jobRow) throw httpError(404, 'distill_job_not_found')
  const job = rowToDistillJob(jobRow) // 既有 helper
  // siblings: 同 debounce_key 全部 jobs（含自己）。详情页通常 1 个，feedback 集中提交时可能多个
  const siblings = db.select().from(memoryDistillJobs)
    .where(eq(memoryDistillJobs.debounceKey, jobRow.debounceKey)).all().map(rowToDistillJob)

  const sourceEvents = await Promise.allSettled(
    siblings.map((s) => resolveSourceEvent(db, s.sourceKind, s.sourceEventId)),
  ).then((rs) => rs.map(toSourceEventEntry))

  const dedupSnapshot = parseDedupSnapshot(jobRow.dedupSnapshotIdsJson)
  const candidates = await loadCandidatesForJob(db, jobId) // 用 memories.source_event_id IN (siblings.sourceEventId)
  return { job: { ...job, opencodeSessionId: jobRow.opencodeSessionId, ... }, siblings, sourceEvents, dedupSnapshot, candidates }
}
```

**source event 解析**：
- clarify → `db.select().from(clarifySessions).where(eq(id, sourceEventId)).get()`，summary =
  `session.questionText.slice(0, 200)`，deepLink = `/clarify/${id}`。
- review → `db.select().from(reviewDocs).where(eq(id, sourceEventId)).get()`，summary = title +
  decision，deepLink = `/reviews/${id}`。
- feedback → `db.select().from(taskFeedback).where(eq(id, sourceEventId)).get()`，summary =
  `body_md.slice(0, 200)`，deepLink = `/tasks/${taskId}#feedback-${id}`。
- 任一类 row missing（用户删了 task / clarify 被 cleanup）→ `deletedOrMissing: true`，前端灰显。

**dedup snapshot 解析**：`parseDedupSnapshot` 容错 JSON.parse 失败 / 字段缺 → 返空数组（老 job 没
该列直接空）。

**candidates 查找**：`SELECT * FROM memories WHERE source_kind IN (...) AND source_event_id IN
(siblings.sourceEventId)`；按 createdAt 升序；只取本次 distill 后生成的（`createdAt >=
job.startedAt`）以避免老的 candidate 也被算进来。

### 5.2 `GET /api/memory/distill-jobs/:jobId`

```ts
app.get('/api/memory/distill-jobs/:jobId', requirePermission('memory:read_distill_jobs'), async (c) => {
  const detail = await getDistillJobDetail(db, c.req.param('jobId'))
  return c.json(detail)
})
```

`memory:read_distill_jobs` 权限点已由 RFC-041 添加（admin only）。

### 5.3 `GET /api/memory/distill-jobs/:jobId/session`

```ts
app.get('/api/memory/distill-jobs/:jobId/session',
  requirePermission('memory:read_distill_jobs'),
  async (c) => {
    const jobId = c.req.param('jobId')
    const events = db.select().from(memoryDistillEvents)
      .where(eq(memoryDistillEvents.distillJobId, jobId))
      .orderBy(memoryDistillEvents.attemptIndex, memoryDistillEvents.ts).all()

    // 按 attemptIndex 分组 → 每组用 RFC-027 既有 parseSessionTree(rows) 还原 tree
    const byAttempt = groupBy(events, (e) => e.attemptIndex)
    const attempts = [...byAttempt.entries()].map(([attemptIndex, rows]) => ({
      attemptIndex,
      rootSessionId: rows[0]?.sessionId ?? null,
      tree: parseSessionTree(rows.map(transcodeEventRowToSharedShape)),
      startedAt: rows[0]?.ts ?? null,
      finishedAt: rows[rows.length - 1]?.ts ?? null,
      exitCode: null, // attempt 级 exitCode v1 不细分，详情接口只暴露最新一次
    }))
    return c.json({ attempts })
  })
```

`parseSessionTree` 是 RFC-027 已有的纯函数（在 `packages/shared/src/sessionView`），输入输出契约
保持不变；本接口只是适配 event row 形态。

## 6. 前端

### 6.1 路由

```ts
// routes/memory.distill-jobs.$jobId.tsx
export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/memory/distill-jobs/$jobId',
  component: DistillJobDetailPage,
})

function DistillJobDetailPage() {
  const isAdmin = usePermission('memory:read_distill_jobs')
  if (!isAdmin) return <AdminOnlyPlaceholder />
  const { jobId } = Route.useParams()
  // 详情 + session 两 query 独立；session 失败不影响侧信息
  const detailQ = useQuery(['memory', 'distill-jobs', jobId, 'detail'], ...)
  const sessionQ = useQuery(['memory', 'distill-jobs', jobId, 'session'], ...)
  useMemoryDistillJobWs() // 已存在，覆盖更新

  return (
    <DetailLayout title={...}>
      <DetailHeader job={detailQ.data?.job} />
      <FailureDiagnostics job={detailQ.data?.job} />
      <SourceEventsList items={detailQ.data?.sourceEvents} siblings={detailQ.data?.siblings} />
      <ScopeAndDedupSnapshot scope={detailQ.data?.job.scopeResolved} snapshot={detailQ.data?.dedupSnapshot} />
      <CandidatesList items={detailQ.data?.candidates} />
      <ConversationSection sessionData={sessionQ.data} />
    </DetailLayout>
  )
}
```

### 6.2 ConversationSection（核心复用）

```tsx
function ConversationSection({ sessionData }: { sessionData: MemoryDistillSessionView | undefined }) {
  const attempts = sessionData?.attempts ?? []
  const [pickedIdx, setPickedIdx] = useState(attempts.length > 0 ? attempts[attempts.length - 1].attemptIndex : 0)
  const picked = attempts.find((a) => a.attemptIndex === pickedIdx)
  if (attempts.length === 0) return <EmptyState title={t('memory.distillJobDetail.noConversation')} />
  return (
    <div className="distill-job-detail__conversation">
      <AttemptPickerLite attempts={attempts} picked={pickedIdx} onPick={setPickedIdx} />
      {picked && <ConversationFlow tree={picked.tree} />}
    </div>
  )
}
```

- `ConversationFlow` 是 RFC-027 已有组件（`packages/frontend/src/components/node-session/ConversationFlow.tsx`），
  入参 `tree` 形态由 backend `/session` 端点提供，与节点 session view 用同一套渲染。
- `AttemptPickerLite` 是 distill 专用的简化版（只按 `attemptIndex` 序号选）：distill 不需要 RFC-027
  那种 inline-session group / shardKey / fanout parent 概念，所以不复用 `SessionTab.AttemptPicker`，
  避免把 distill 概念硬塞进节点 session UI；样式选 RFC-036 的通用 `<Select>`。

### 6.3 SourceEventsList / ScopeAndDedupSnapshot / CandidatesList / FailureDiagnostics

- `SourceEventsList`：siblings + 主 job 的 sourceEvents 一并展示；按 sourceKind 分组（clarify /
  review / feedback 各一段），每行 `<StatusChip>` + title + `<RouterLink to={deepLink}>` open；
  `deletedOrMissing` 时不可点击 + 灰文 "source deleted"。
- `ScopeAndDedupSnapshot`：scope chip 行（agent ids count / workflow id / repo id / global on）+
  下方 dedup snapshot 表（title / scope chip）；空时 EmptyState "No prior memories were visible
  to the distiller"。
- `CandidatesList`：按 `currentStatus` 排序（candidate 在前），每行 distillAction badge + title
  + jump to `/memory?focus=<memoryId>`（复用 RFC-041 Approval Queue 既有 hash anchor）。
- `FailureDiagnostics`：仅在 `job.exitCode !== 0 || job.lastError !== null || job.attempts > 0`
  时展开；显示 exitCode、attempts、`<pre>` stderr 摘要（monospace + max-height + scroll）。

### 6.4 MemoryDistillJobsTable 改造

行级整行 onClick → `router.navigate({ to: '/memory/distill-jobs/$jobId', params: { jobId } })`；
现有 retry / cancel 两个按钮容器加 `onClick={(e) => e.stopPropagation()}`；行加 `cursor: pointer`
+ hover bg（用 RFC-035 设计 token）。

### 6.5 i18n

新 ~22 key，中英对称：

```
memory.distillJobDetail.title                = "Distill job detail" / "记忆提炼任务详情"
memory.distillJobDetail.section.sourceEvents = "Source events" / "源事件"
memory.distillJobDetail.section.scope        = "Scope & dedup snapshot" / "范围与去重快照"
memory.distillJobDetail.section.candidates   = "Candidates produced" / "本次生成的候选记忆"
memory.distillJobDetail.section.diagnostics  = "Failure diagnostics" / "失败诊断"
memory.distillJobDetail.section.conversation = "Distiller conversation" / "提炼器对话"
memory.distillJobDetail.attempt              = "Attempt {{n}}" / "第 {{n}} 次尝试"
memory.distillJobDetail.noConversation       = "Conversation will appear once the run completes" / "运行完成后才会出现对话"
memory.distillJobDetail.noCandidates         = "No candidates emitted" / "本次未生成候选"
memory.distillJobDetail.noDedupSnapshot      = "No prior memories were visible to the distiller" / "本次提炼时无可见的已批准记忆"
memory.distillJobDetail.sourceDeleted        = "source deleted" / "源已删除"
memory.distillJobDetail.exitCode             = "Exit code: {{code}}" / "退出码：{{code}}"
memory.distillJobDetail.attemptsCount        = "{{n}} attempt(s)" / "尝试次数：{{n}}"
memory.distillJobDetail.stderrLabel          = "Subprocess stderr (truncated)" / "子进程 stderr（截断）"
memory.distillJobDetail.adminOnly            = "Distill detail is admin-only" / "提炼详情仅 admin 可见"
memory.distillJobDetail.openInQueue          = "Open in Approval Queue" / "在审批队列中打开"
memory.distillJobDetail.candidateStatus      = "Current status: {{status}}" / "当前状态：{{status}}"
memory.distillJobDetail.distillAction        = "Action: {{action}}" / "动作：{{action}}"
memory.distillJobDetail.captureFailed        = "Conversation capture failed; raw outputs only" / "对话捕获失败；仅可看 raw 输出"
memory.distillJobDetail.userPromptHidden     = "User prompt re-derives from first message of each attempt" / "User prompt 由每次 attempt 第一条消息还原"
memory.distillJobDetail.loadError            = "Failed to load distill job detail" / "加载提炼任务详情失败"
memory.distillJobDetail.sessionLoadError     = "Failed to load conversation" / "加载对话失败"
```

## 7. 失败模式 & 兼容性

| 场景 | 行为 |
|---|---|
| 老 distill job 无新 5 列（migration 前的行） | 详情接口返回 null 字段；前端各 Section 显示 EmptyState；不报错 |
| 老 distill job 的 sourceEvent 被删 | `deletedOrMissing: true`，行灰显 "source deleted" |
| dedup_snapshot_json 坏 JSON | `parseDedupSnapshot` catch + 返空数组 |
| `extractSessionIdFromStderr` 没抓到 sessionId | 不调 capture；详情页对话区 EmptyState |
| `captureDistillJobSession` 抛错 | 静默 + warn log；写 `rfc043/distill-capture-failed` marker 行；详情页对话区显示 `captureFailed` 提示 + stderr 摘要兜底 |
| 同 debounce_key 多 siblings 但只取主 job 跑 distill | sourceEvents 区显示全部 siblings 来源，符合用户期望 |
| /distill-jobs/:invalidId | 详情接口 404；前端 EmptyState "Not found" + 返回 Distill Jobs tab 链接 |
| 非 admin 直接访问路由 | 前端 AdminOnlyPlaceholder；后端 requirePermission 403 兜底 |
| stderr 含 git URL 含 token | `clipAndRedact` 走 redactGitUrl + 截断 2KB |
| 详情接口被高频拉（distiller 还在跑时 WS push） | useQuery + WS invalidate 走现有 React Query 缓存，5s 内重复请求合并；接口 SQL 全走索引，单次成本 < 10ms |

## 8. 测试策略

按 CLAUDE.md "Test-with-every-change" 原则，本 RFC 落地必带的测试用例：

### 8.1 backend
- `migration-0024-distill-capture.test.ts` (2)：新表 + 5 列 schema 校验；FK CASCADE 删 job → events 同删。
- `memoryDistiller-capture-integration.test.ts` (5)：spawn mock 返 sessionId/stderr/exitCode →
  期望 5 新列被写入；exitCode=0 → 跑 capture；exitCode=1 → 也跑 capture（失败诊断 path）；
  attempts=0 写 prompt；attempts>0 不重写 prompt（避免覆盖首次 prompt）；capture throw → swallow。
- `distillSessionCapture.test.ts` (4)：BFS 子 session 正常 / opencode db 缺失 → marker / parent_id
  循环 → visited set bound / 已被 sibling 捕获的 sessionId 不在本场景中（distill 无 sibling 概念）→
  全部走 capture 路径不跳过。
- `memoryDistillJobDetail.test.ts` (8)：聚合 happy path / siblings 多个 / sourceEvent 删 →
  deletedOrMissing / dedupSnapshot null → 空数组 / candidates 时间窗过滤 / 老 job 五列 NULL →
  返默认 / 404 / SQL 索引命中（plan check）。
- `routes-memory-distill-job-detail.test.ts` (5)：admin 200 / non-admin 403 / 错 jobId 404 /
  session 端点 200 多 attempt 分组正确 / capture 失败的 job → session 端点返 attempts:[] + marker。

### 8.2 frontend
- `distill-job-detail-route.test.tsx` (3)：admin 渲染 / non-admin 渲染 AdminOnly / loading
  spinner。
- `distill-job-detail-source-events-list.test.tsx` (4)：3 sourceKind 分组渲染 / deepLink 正确 /
  deletedOrMissing 灰显 / 空 EmptyState。
- `distill-job-detail-candidates-list.test.tsx` (3)：行点击 → 跳 /memory?focus=... / 多 status
  排序 / 空 EmptyState。
- `distill-job-detail-failure-diagnostics.test.tsx` (3)：exitCode!=0 展开 / 成功折叠 / stderr
  redact 后渲染。
- `distill-job-detail-conversation-section.test.tsx` (4)：attempts 多选切换 / 单 attempt 默认
  渲染 / EmptyState 当 attempts=[] / sessionQuery 失败 显示局部 error box（不影响其它 section）。
- `distill-job-detail-table-row-click.test.tsx` (2)：行点击跳路由 / retry 按钮 stopPropagation 不
  触发跳转。
- `i18n-distill-job-detail-keys.test.ts` (2)：22 key 对称 / placeholder `{{n}}/{{code}}/...` 一致。
- `lib-distill-job-detail.test.ts` (5)：groupSourceEventsByKind / formatExitCode / truncateStderr
  long input / selectAttempts 排序 / sessionEventsToTree 适配器空输入。

### 8.3 e2e（Playwright）
- v1 不强制新增（Distill Jobs tab 在 RFC-041 PR4 已锁，行点击跳转 / 详情页 4 section 渲染走前端
  路由 happy path，单测+集成已覆盖）。如果 follow-up 需要可后续加 1 个 spec。

### 8.4 grep 守卫
- `distill-detail-grep.test.ts` 锁 2 条：(1) `MemoryDistillJobsTable` 行元素必须有
  `onClick` 跳路由（防止后续重构丢失整行点击）；(2) `ConversationFlow` 只被 `SessionTab` 和
  `ConversationSection` 引用，避免新组件错误复用。

预估总 +~50 测试，主仓现有约 1411 backend + 1697 frontend 后维持零退化。

## 9. PR 拆分

单 PR 推送（约 +20 文件 / +1200 LOC 量级，含测试），prefix `feat(memory): RFC-043 distill job
detail page`。三件套和 STATE.md 同 PR 内更新。原因：
- 后端 capture 改动 + 前端详情页强耦合，分 PR 反而要造一堆 stub mock 不划算。
- 改动均增量 + 非 hot-path，不会影响 RFC-041 当前线上候选/审批/注入流程。

若 review 反馈太大，回退方案：先拆 PR1（backend 捕获 + 接口 + 测试）→ PR2（前端 + 路由 + 测试），
RFC `plan.md` 的 T1..T7 拆分已经预留这条切线。

## 10. 安全考量

- 详情接口对 stderr 输出走 `clipAndRedact + redactGitUrl`，避免 SSH/HTTPS token 泄漏。
- distiller 的 user prompt 含用户 feedback / clarify Q&A 等原文；详情页 admin only（与
  Approval Queue 现有粒度一致），不放给普通 user。
- dedup_snapshot_ids_json 只存 memoryId + 渲染所需最小列（title / scopeType / scopeId），不冗存
  body_md（保持记忆 immutable + supersede 链的 source of truth 仍是 memories 表，避免双写）。
- session 端点返回的 `payload_json` 是 distiller 对话原文，复用 RFC-027 已有 sanitize 路径（如有）；
  RFC-043 不引新 sanitizer。

## 11. 文档与 STATE.md 同步

落 PR 时：
- `design/plan.md` RFC 索引追加 `RFC-043 | 记忆提炼任务详情页 | Draft`。
- `STATE.md` 顶部 "进行中 RFC" 加一行 `RFC-043 distill job detail`；完工后转 Done 并入"已完成"区。
