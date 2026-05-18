# RFC-040 — 技术设计

> 配套 [proposal.md](./proposal.md)。proposal 钉产品意图，本文件钉技术契约 + 文件级落点。

## 1. 模块拓扑

```
packages/backend/
  db/migrations/
    0022_rfc040_wrapper_progress.sql   # ALTER TABLE node_runs ADD wrapper_progress_json
  src/
    db/schema.ts                       # node_runs.wrapperProgressJson 列声明
    services/
      scheduler.ts                     # 主战场
        - runLoopWrapperNode           # 上抛 awaiting_*；持久化 progress；resume 路径
        - runGitWrapperNode            # 同上（无 iteration，仅 baseline + phase）
        - resumeWrapperRun (新)        # 共用 helper：按 nodeId+iteration 查既有 wrapper run
        - persistWrapperProgress (新)  # 共用 helper：写 wrapper_progress_json
      wrapperProgress.ts (新)          # 纯函数 module：encode/decode/parse zod schema
packages/shared/src/
  schemas/
    nodeRun.ts                         # NodeRunSchema.wrapperProgressJson 字段（必须可空）
packages/backend/tests/
  scheduler-loop-clarify.test.ts (新)  # AC-2, AC-3
  scheduler-loop-review.test.ts (新)   # AC-4
  scheduler-git-clarify.test.ts (新)   # AC-5
  scheduler-git-review.test.ts (新)    # 兄弟 case
  scheduler-loop-multiprocess-clarify.test.ts (新)  # AC-6 乘性
  scheduler-wrapper-nested-await.test.ts (新)       # AC-7 嵌套
  scheduler-wrapper-resume.test.ts (新)             # daemon-restart 模拟 AC-8
  scheduler-wrapper-cancel-while-awaiting.test.ts (新) # AC-9
  wrapper-progress-schema.test.ts (新) # 纯函数 module 单测
  migration-0022.test.ts (新)          # AC-1
```

**不动模块**：runner / opencode plugin / workflow editor / workflow validator / workflow YAML import/export / WS broadcaster 协议 / clarify service 核心 / review service 核心 / fanout (multi-process) 节点自身 park 逻辑 / git wrapper 的 baseline+diff 算法 / loop wrapper 的 exit_condition 三 kind 评估器。

## 2. DB 设计

### Migration 0022_rfc040_wrapper_progress.sql

```sql
ALTER TABLE `node_runs` ADD `wrapper_progress_json` text;
```

> **不回填**。老 wrapper 行（升级前 in-flight）column 默认 NULL，behavior 等价于"未持久化进度"——升级后第一次重入走 init 路径（与今天 daemon-restart 行为一致），不引入回归。

> **不加索引**。本字段只在 `runOneNode → runLoopWrapperNode / runGitWrapperNode` 路径上被读取，按 `(taskId, nodeId, iteration)` 已有 `idx_node_runs_task` 索引覆盖检索。

### Drizzle schema 改动

`packages/backend/src/db/schema.ts` `nodeRuns` 表追加：

```ts
/**
 * RFC-040: serialized `WrapperProgress` (services/wrapperProgress.ts) used
 * by wrapper-loop / wrapper-git to resume from the iteration / baseline
 * where they parked when an inner node entered awaiting_human /
 * awaiting_review. NULL for non-wrapper runs and for wrapper runs that
 * never parked (single-shot init → done in one call).
 */
wrapperProgressJson: text('wrapper_progress_json'),
```

放在 `inventorySnapshotJson` 之后，保持"按 RFC 编号自然顺序追加"惯例。

## 3. Shared schema

### `packages/shared/src/schemas/nodeRun.ts`

```ts
export const NodeRunSchema = z.object({
  // ... 既有字段
  inventorySnapshotJson: z.string().nullable().optional(),
  wrapperProgressJson: z.string().nullable().optional(), // RFC-040
})
```

> 字段保持 `string | null | undefined`（DB 行直接序列化），不在 shared 层做 JSON parse —— parse 留给 backend 内部 `wrapperProgress.ts` 模块（避免前端被迫消费这个内部字段；前端 UI 仅看 `node_runs.status`）。

## 4. 后端

### 4.1 新模块 `services/wrapperProgress.ts`

```ts
import { z } from 'zod'

export const WrapperProgressSchema = z
  .object({
    kind: z.enum(['loop', 'git']),
    /** wrapper-loop only: which iteration we parked on. NEVER undefined for kind='loop'. */
    iteration: z.number().int().nonnegative().optional(),
    /** wrapper-git only: baseline commit captured before inner scope. NEVER undefined for kind='git'. */
    baseline: z.string().optional(),
    /** 'inner-running' = before runScope returned; 'awaiting' = parked on
     * awaiting_*; 'iter-done' (loop only) = iteration N's scope returned ok,
     * about to evaluate exit_condition / advance to N+1. */
    phase: z.enum(['inner-running', 'awaiting', 'iter-done']),
  })
  .passthrough() // forward-compat for future fields

export type WrapperProgress = z.infer<typeof WrapperProgressSchema>

export function encodeWrapperProgress(progress: WrapperProgress): string {
  return JSON.stringify(progress)
}

/** Returns null on parse failure → caller treats as "no progress, run init path".
 *  Logs the malformed payload at warn for ops debugging. */
export function decodeWrapperProgress(
  raw: string | null | undefined,
  log: (msg: string) => void,
): WrapperProgress | null {
  if (raw == null || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    const r = WrapperProgressSchema.safeParse(parsed)
    if (!r.success) {
      log(`[rfc040] wrapper_progress_json parse failed: ${r.error.message}`)
      return null
    }
    return r.data
  } catch (e) {
    log(`[rfc040] wrapper_progress_json invalid JSON: ${(e as Error).message}`)
    return null
  }
}
```

**测试**：`wrapper-progress-schema.test.ts` 覆盖：

- `encode/decode` round-trip（kind='loop' iter=0 phase='awaiting' / kind='git' baseline='abc123' phase='awaiting' / phase='iter-done'）
- decode null / 空串 → null
- decode 非 JSON → null + log 调用
- decode 不符 schema → null + log 调用
- passthrough 字段不丢

### 4.2 `services/scheduler.ts` `runLoopWrapperNode` 重写

伪代码（实际代码注释会逐行说明）：

```ts
async function runLoopWrapperNode(state, args) {
  const { db, taskId } = state
  const { node, iteration: parentIteration, log } = args
  const inner = pickStringArray(node, 'nodeIds')
  if (inner.length === 0) { return { kind: 'failed', summary: ..., message: 'wrapper-empty' } }
  const maxIter = pickNumber(node, 'maxIterations')
  if (!isValidMaxIter(maxIter)) { return { kind: 'failed', ..., message: 'wrapper-loop-max-iterations' } }
  const cond = parseExitCondition((node as any).exitCondition)
  if (cond === null) { return { kind: 'failed', ..., message: 'wrapper-loop-exit-condition' } }
  const bindings = readBindings(node, 'outputBindings')

  // ---- RFC-040 resume detection ----
  const existing = await findResumableWrapperRun(db, taskId, node.id, parentIteration, 'loop')
  let wrapperRunId: string
  let startIter: number

  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, log.warn)
    if (progress?.kind === 'loop' && typeof progress.iteration === 'number') {
      wrapperRunId = existing.id
      startIter = progress.iteration // resume at same iteration; phase decides skip-ahead
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running') // back from awaiting
      await db.update(nodeRuns).set({ status: 'running' }).where(eq(nodeRuns.id, wrapperRunId))
    } else {
      // progress malformed: treat as fresh init (do NOT mint a second wrapper row;
      // reuse existing id but reset iteration to 0 — observable but recoverable).
      wrapperRunId = existing.id
      startIter = 0
    }
  } else {
    wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, parentIteration)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    startIter = 0
  }

  const innerSet = new Set(inner)
  for (let i = startIter; i < maxIter; i++) {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop', iteration: i, phase: 'inner-running',
    })

    const subRes = await runScope(state, {
      scopeIds: innerSet,
      iteration: i,
      log: log.child(`loop:${node.id}`),
    })

    if (subRes.kind === 'canceled') {
      await markWrapperTerminal(db, wrapperRunId, 'canceled', subRes.detail?.summary)
      return { kind: 'canceled', summary: ..., message: '' }
    }
    if (subRes.kind === 'failed') {
      await markWrapperTerminal(db, wrapperRunId, 'failed', subRes.detail?.message)
      return { kind: 'failed', ... }
    }

    // ---- RFC-040 awaiting bubble ----
    if (subRes.kind === 'awaiting_human' || subRes.kind === 'awaiting_review') {
      await persistWrapperProgress(db, wrapperRunId, {
        kind: 'loop', iteration: i, phase: 'awaiting',
      })
      const newStatus = subRes.kind === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review'
      await db.update(nodeRuns).set({ status: newStatus }).where(eq(nodeRuns.id, wrapperRunId))
      broadcastNodeStatus(taskId, wrapperRunId, node.id, newStatus)
      return subRes // bubble up unchanged — task-level runOnce parks task chip
    }

    // subRes.kind === 'ok': evaluate exit condition for this iteration.
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'loop', iteration: i, phase: 'iter-done',
    })
    const portContent = await readPortAtIteration(db, taskId, cond.nodeId, cond.portName, i)
    if (evaluateExitCondition(cond, portContent)) {
      for (const b of bindings) {
        const v = await readPortAtIteration(db, taskId, b.bind.nodeId, b.bind.portName, i)
        await db.insert(nodeRunOutputs).values({ nodeRunId: wrapperRunId, portName: b.name, content: v })
      }
      await markWrapperTerminal(db, wrapperRunId, 'done')
      return { kind: 'ok', summary: '', message: '' }
    }
    // exit not satisfied; loop body continues to i+1
  }

  // Exhausted
  await markWrapperTerminal(db, wrapperRunId, 'exhausted', 'max iterations reached')
  return { kind: 'failed', summary: ..., message: 'wrapper-loop-exhausted' }
}
```

新 helper：

```ts
async function findResumableWrapperRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  parentIteration: number,
  wrapperKind: 'loop' | 'git',
): Promise<typeof nodeRuns.$inferSelect | null> {
  // The dispatcher only re-dispatches a wrapper when its latest row is NOT
  // `done` (see runScope:326-330). So awaiting_* / running / pending are the
  // candidate states. We MUST match parentIteration to avoid grabbing a
  // sibling iteration's wrapper run from a nested-in-loop scenario.
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(
      and(
        eq(nodeRuns.taskId, taskId),
        eq(nodeRuns.nodeId, nodeId),
        eq(nodeRuns.iteration, parentIteration),
      ),
    )
    .orderBy(desc(nodeRuns.id))
    .limit(1)
  if (rows.length === 0) return null
  const r = rows[0]!
  if (r.status === 'done' || r.status === 'failed' || r.status === 'canceled'
      || r.status === 'exhausted') {
    return null // terminal — caller should NOT resume; new dispatch would mean a fresh wrapper invocation in a parent wrapper iteration
  }
  // status in {pending, running, awaiting_human, awaiting_review, interrupted}
  // → eligible for resume
  return r
}
```

```ts
async function persistWrapperProgress(
  db: DbClient,
  wrapperRunId: string,
  progress: WrapperProgress,
): Promise<void> {
  await db.update(nodeRuns)
    .set({ wrapperProgressJson: encodeWrapperProgress(progress) })
    .where(eq(nodeRuns.id, wrapperRunId))
}

async function markWrapperTerminal(
  db: DbClient,
  wrapperRunId: string,
  status: 'done' | 'failed' | 'canceled' | 'exhausted',
  errorMessage?: string,
): Promise<void> {
  await db.update(nodeRuns)
    .set({
      status,
      finishedAt: Date.now(),
      ...(errorMessage ? { errorMessage } : {}),
      // 注意：progress 不清空，留作排错追踪；wrapper 进入终态后该字段不会再被消费。
    })
    .where(eq(nodeRuns.id, wrapperRunId))
}
```

### 4.3 `runGitWrapperNode` 重写

同模式，但去掉 iteration（git wrapper 没有循环），加 baseline 字段：

```ts
async function runGitWrapperNode(state, args) {
  // ... 取 inner / 必填校验 ...

  const existing = await findResumableWrapperRun(db, taskId, node.id, iteration, 'git')
  let wrapperRunId: string
  let baseline: string

  if (existing !== null) {
    const progress = decodeWrapperProgress(existing.wrapperProgressJson, log.warn)
    if (progress?.kind === 'git' && typeof progress.baseline === 'string') {
      wrapperRunId = existing.id
      baseline = progress.baseline // **don't re-capture HEAD** — worktree has already diverged
      broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
      await db.update(nodeRuns).set({ status: 'running' }).where(eq(nodeRuns.id, wrapperRunId))
    } else {
      // malformed → reuse row but re-capture (best-effort)
      wrapperRunId = existing.id
      baseline = await captureHead(task.worktreePath)
    }
  } else {
    wrapperRunId = await insertNodeRun(db, taskId, node.id, 'pending', 0, iteration)
    broadcastNodeStatus(taskId, wrapperRunId, node.id, 'running')
    baseline = await captureHead(task.worktreePath)
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'git', baseline, phase: 'inner-running',
    })
  }

  const subRes = await runScope(state, {
    scopeIds: new Set(inner), iteration, log: log.child(`git:${node.id}`),
  })
  if (subRes.kind === 'canceled') { ... markWrapperTerminal(...); return ... }
  if (subRes.kind === 'failed')   { ... markWrapperTerminal(...); return ... }

  if (subRes.kind === 'awaiting_human' || subRes.kind === 'awaiting_review') {
    await persistWrapperProgress(db, wrapperRunId, {
      kind: 'git', baseline, phase: 'awaiting',
    })
    const newStatus = subRes.kind === 'awaiting_human' ? 'awaiting_human' : 'awaiting_review'
    await db.update(nodeRuns).set({ status: newStatus }).where(eq(nodeRuns.id, wrapperRunId))
    broadcastNodeStatus(taskId, wrapperRunId, node.id, newStatus)
    return subRes
  }

  // subRes.kind === 'ok': compute diff using persisted baseline
  let diff = ''
  try {
    diff = await gitDiffSnapshot(task.worktreePath, baseline || 'HEAD')
  } catch { diff = '' }
  await db.insert(nodeRunOutputs).values({ nodeRunId: wrapperRunId, portName: 'git_diff', content: diff })
  await markWrapperTerminal(db, wrapperRunId, 'done')
  return { kind: 'ok', summary: '', message: '' }
}
```

> **`captureHead` 抽出**：当前内联 `try/catch` 的 `git rev-parse HEAD`（`scheduler.ts:1089-1094`）抽成本地 helper，方便 init / 异常恢复路径复用，避免重复 boilerplate。

### 4.4 不动 `runOnceTask` / `runScope` 主体

- `runOnceTask`（task 入口，`:204-238`）仍然在 result.kind = awaiting_* 时把 `tasks.status` 切到对应值——wrapper 上抛出的 awaiting_* 与 review/clarify 节点的 awaiting_* 走同一条出口。
- `runScope`（`:296-454`）保持 RFC-023 bug 13 的批次内 awaiting 聚合 + 跨批次 rescan 行为。wrapper 的 awaiting_* 上抛只是把"内层 scope 的 awaiting 信号"原样转交，不需要 scope 层额外感知 wrapper。
- `rescanScopeForNewPendingRows`（`:470` 附近）保持现状——当用户答完 clarify、`submitClarifyAnswers` mint 新 Agent rerun 行后，wrapper resume re-call `runScope` 时，rescan 会拾起新行。

### 4.5 与 review / clarify rerun 路径的交互

- **clarify rerun**：`submitClarifyAnswers` (`clarify.ts:291`) mint 新 Agent node_run 行 + 调 `resumeTask`。resumeTask 重入 dispatcher → wrapper 的 latest row 状态是 `awaiting_human`（非 done），所以 wrapper 进入 ready 集合 → `runLoopWrapperNode` resume 路径触发 → 从 progress.iteration 续 `runScope` → 内层 `rescanScopeForNewPendingRows` 拾起新 Agent 行 → 跑完 → ok 上抛 → 评估 exit_condition。
- **review decision = approve**：`submitReviewDecision` 把 review node_run 标 `done`、不 mint 新行 → resumeTask → wrapper resume → `runScope` 内 review 已 done、Agent 已 done → scope 直接 returns ok → wrapper 评估 exit_condition / 算 diff。
- **review decision = reject / iterate**：现有 `scheduler.ts:2107` 附近路径给 source agent mint retry 行（保留同 iteration / clarifyIteration / shard），review 自身 mint 新 awaiting 行 → resumeTask → wrapper resume → scope 内 retry agent 重跑 → 再次 review awaiting → wrapper 再次上抛 awaiting_review（同 progress.iteration）。**关键不变量**：retry / review-iterate 不改变 `parentIteration`，wrapper 不需要"重新开始"。新增 `scheduler-wrapper-resume-review-iterate.test.ts` 锁这条契约。

### 4.6 不动 fanout (multi-process) 节点

`runFanOutNode`（`:1149+`）已经正确把子 shard 的 awaiting_* 上抛（`:1413-1416`）。multi-process 直接作为 wrapper 内的一个普通节点存在，wrapper-loop 修复后乘性 storm 自然消失，无需改 fanout 自身。

## 5. WS / API 影响

- **WS**：`broadcastNodeStatus(taskId, wrapperRunId, node.id, 'awaiting_human' | 'awaiting_review')` 在 wrapper 上抛时调用 —— payload schema 不变（`NodeStatusEventSchema` 已支持这两个 status），前端 `useTasksSync` / `useNodeStatusWs` 收到后渲染 chip 即可。
- **REST**：`GET /api/tasks/$id/node-runs` 响应中 wrapper 行 status 字段会出现 `awaiting_human` / `awaiting_review`；shared `NodeRunSchema.status` 已包含这两个枚举，无 schema 改动。`wrapperProgressJson` 字段透传给前端但**前端不消费**（debug 用，类似 `inventorySnapshotJson` 在前端只展示）。
- **`/api/clarify/sessions/:id/answers` POST**（`routes/clarify.ts:147`）后调 `resumeTask` 的语义不变——本 RFC 让 resumeTask 在 wrapper 内续跑时真正复活已挂起的 wrapper run。
- **`/api/reviews/:id/decisions` POST** 同理。

## 6. 测试策略

总量 ≥ 12 case（实际可能 15-20）。

### 6.1 单元：wrapperProgress 模块（≥ 6）

`packages/backend/tests/wrapper-progress-schema.test.ts`

- encode/decode round-trip loop kind
- encode/decode round-trip git kind
- decode null → null
- decode 非 JSON → null + log
- decode 不符 schema（missing kind）→ null + log
- decode passthrough 字段保留

### 6.2 DB migration（≥ 1）

`packages/backend/tests/migration-0022.test.ts`

- 跑 0021 → INSERT 一行 node_runs（不带 wrapper_progress_json）→ 跑 0022 → 列存在 + 老行该字段 NULL + 新行可写非空
- 老 wrapper 行升级后 NULL → wrapper 续跑走 init 路径（断言：不创建第二个 wrapper row，但 iteration 从 0 重启——这是已知 caveat，测试锁它当前行为以警示未来阅读者）

### 6.3 wrapper-loop + clarify（≥ 2）

`packages/backend/tests/scheduler-loop-clarify.test.ts`

- AC-2：构造 wrapper-loop(maxIter=3) ∋ {agent-single, clarify}，mock agent 第 0 轮 emit clarify envelope → 跑一次 dispatch → 断言：
  - clarify_session count == 1（不是 3）
  - wrapper node_run.status == 'awaiting_human'
  - wrapper progress.iteration == 0, phase == 'awaiting'
  - task.status == 'awaiting_human'
  - agent node_run for iter 1, 2 不存在
- AC-3：续上，调 submitClarifyAnswers → 调 resumeTask → 断言：
  - wrapper status 回 'running' → 'done'（如果 exit_condition 在 iter 0 满足）
  - 同 wrapperRunId（不是新 row）
  - clarify_session.status == 'answered'
  - agent rerun（clarifyIteration=1）跑完且 normal port output 写入

### 6.4 wrapper-loop + review（≥ 2）

`packages/backend/tests/scheduler-loop-review.test.ts`

- AC-4：构造 wrapper-loop(maxIter=3) ∋ {agent-single, review}，mock agent 第 0 轮写 port → dispatch → 断言：
  - review_doc count == 1
  - wrapper status == 'awaiting_review'
- 用户 POST review approve → resumeTask → wrapper iter 0 落 done → wrapper terminal done

### 6.5 wrapper-git + clarify（≥ 2）

`packages/backend/tests/scheduler-git-clarify.test.ts`

- AC-5：构造 wrapper-git ∋ {agent-single, clarify}，agent emit clarify → 断言：
  - **wrapper 没有 git_diff 输出行**（关键：今天 bug 会有错误 diff）
  - wrapper progress.kind == 'git', baseline 非空, phase == 'awaiting'
  - wrapper status == 'awaiting_human'
- 用户答 clarify → resumeTask → wrapper 不重新 capture HEAD（断言 progress.baseline 不变）→ scope 跑完 → 一条 git_diff 行（最终态）

### 6.6 wrapper-git + review

`packages/backend/tests/scheduler-git-review.test.ts`：兄弟形态，省略详写。

### 6.7 wrapper-loop + multi-process(agent) + clarify

`packages/backend/tests/scheduler-loop-multiprocess-clarify.test.ts`

- AC-6：构造 wrapper-loop(maxIter=3) ∋ multi-process(sourcePort='input.files', agent-shard)，3 个 shard，每 shard 抛 clarify → 断言：
  - 一轮内 3 条 clarify_session（一轮内 fanout 正确）
  - 不存在第 2、3 轮 fanout（关键：今天 bug 会 3×3 = 9 条）

### 6.8 嵌套场景（≥ 1）

`packages/backend/tests/scheduler-wrapper-nested-await.test.ts`

- AC-7：wrapper-git ∋ wrapper-loop(maxIter=2) ∋ {agent, clarify}
- 断言：内 loop 上抛 awaiting_human 给外 git，外 git 也 awaiting_human、不算 diff；答完后整链续跑

### 6.9 daemon-restart 模拟（≥ 1）

`packages/backend/tests/scheduler-wrapper-resume.test.ts`

- AC-8：模拟"wrapper 跑到 iter 1、persistWrapperProgress 写完、然后整个 SchedulerState 抛弃 + 新建"——直接调 runOneNode(wrapper) 第二次，断言：
  - findResumableWrapperRun 命中 awaiting 行
  - wrapperRunId 复用
  - startIter == 1
  - clarify_session 不重复 mint

### 6.10 cancel 在 awaiting 态生效

`packages/backend/tests/scheduler-wrapper-cancel-while-awaiting.test.ts`

- AC-9：wrapper awaiting_human → POST cancel → wrapper status 'canceled'；clarify_session 行保留（RFC-023 §5.2 不变）

### 6.11 review-iterate 在 wrapper 内不破契约

`packages/backend/tests/scheduler-wrapper-resume-review-iterate.test.ts`

- review decision = iterate → source agent retry → review awaiting 再次抛 → wrapper 同 progress.iteration 不前进
- 关键：retry agent 的 iteration 仍是 0，wrapper progress.iteration 也是 0；不能误把 retry 当 iter+1

### 6.12 既有套件零退化

跑全套 `bun run test`，重点关注：

- `packages/backend/tests/scheduler-*.test.ts` —— 20+ 现存调度测试
- `packages/backend/tests/clarify-*.test.ts` —— 20 个 clarify 测试
- `packages/backend/tests/review-*.test.ts`
- `packages/backend/tests/wrapper-*.test.ts`（若已存在）

预期：零退化（本 RFC 不改 wrapper 的正常路径，仅加 resume + awaiting 上抛）。

## 7. 失败模式

| 场景                                                        | 行为                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| wrapper_progress_json 损坏 / 不合 schema                    | decodeWrapperProgress 返 null + warn log；走 init 路径（最坏退化到当前 bug，可观察）       |
| wrapper progress 写入失败（DB 异常）                        | 上游 catch 抛错 → wrapper run 标 failed → 任务标 failed；用户可重启任务，不影响其它 task   |
| daemon 重启时 wrapper 处于 inner-running phase（未达 awaiting）| 重启后 findResumableWrapperRun 命中 status='running' 行 → resume 从 progress.iteration 重跑当轮（agent 已 done 行被 rescan 当作 completed，scope 立刻进 exit_condition 评估，不重复跑 agent） |
| 用户答 clarify 但 task 已被 cancel                          | resumeTask 抛 task-not-resumable（既有路径），clarify 答案被 mint 但 wrapper 已 canceled、不再续跑（与今天 review-on-canceled-task 一致） |
| 同一 wrapper 节点被多个 task 启动（并发）                   | 每个 task 自己的 wrapper run，taskId 是主隔离键；不互相影响（既有约束）                    |
| wrapper 内层 scope 抛同时 awaiting_human + awaiting_review（两个挂起节点） | runScope 已按优先级 awaiting_human > awaiting_review 上抛（`:337-340`）→ wrapper 标 awaiting_human；用户答 clarify 后续跑 → 下一次 runScope 又抛 awaiting_review → wrapper 标 awaiting_review；自然链式 |
| wrapper-loop maxIter=0                                      | 既有校验返 failed `wrapper-loop-max-iterations` 不变                                       |
| wrapper-loop 内 review 上抛后用户 reject                    | review-iterate 路径触发 → source agent retry → wrapper 持 iteration 不变 → 再次 awaiting_review 上抛 → 链式直到用户 accept 或 max iter |

## 8. 兼容与回退

- **API**：零破坏。`NodeRunSchema.wrapperProgressJson` 是可选字段，前端不消费；老客户端不受影响。
- **WS**：零破坏。wrapper 的 awaiting_* 复用既有 `NodeStatusEventSchema` 状态值。
- **DB**：单向 ALTER ADD。回退路径 = 应用层回退到 RFC-040 前版本，新列保留为冗余字段（无负担）。不写自动 down migration（本仓既有惯例）。
- **Workflow YAML / 编辑器**：零改动。workflow definition / canvas / NodeInspector 不动。
- **opencode 集成**：零改动。runner / inline session / inventory 全部不动。
- **既有 in-flight wrapper 行升级**：progress NULL → 走 init 路径，从 iter 0 重启（与今天 daemon-restart 行为一致）；release note 列已知 caveat。

## 9. 与其它 RFC 的兼容

- **RFC-005 human review**：review 节点 awaiting_review 上抛路径不变；wrapper 现在能正确接住、不再继续轮。`scheduler-wrapper-resume-review-iterate.test.ts` 锁 review-iterate 路径不破。
- **RFC-016 wrapper container UX**：wrapper UX（拖入拖出 / Inspector）不动；wrapper status 在 chip 上的呈现复用现有 awaiting chip（与 review/clarify 节点一致）。
- **RFC-022 dependsOn 闭包注入**：不在 wrapper 路径上；零交互。
- **RFC-023 agent clarify**：clarify rerun 路径 (`submitClarifyAnswers`) 不变；wrapper 通过 status='awaiting_human' 与现有 task chip 优先级（awaiting_human > awaiting_review > failed > ok）天然集成。新增的 multi-process-in-loop 测试覆盖 RFC-023 fanout 的边界。
- **RFC-026 clarify inline-session**：inline 与 isolated 路径都不感知 wrapper resume；inline 的 session_id 仍按 clarifyIteration 拉最近一条 transcript。
- **RFC-027 node session view** / **RFC-029 inventory snapshot**：wrapper 节点不跑 opencode、无 session_id / inventory，零交互。
- **RFC-036 multi-user collab**：wrapper resume 沿用 task 既有 actor 上下文；review-iterate / clarify-answer 权限校验由现有 `ensureReviewerAuth` / `ensureClarifyAnswerAuth` 负责。
- **RFC-037 task.name**：零交互。
- **RFC-038 agent deps autodetect**：纯前端 RFC，零交互。

## 10. 与 opencode 源码的关系

无。本 RFC 不涉及 opencode 进程 / CLI 参数 / env vars / XML envelope。wrapper 是平台调度层概念，opencode 不感知。runner / opencode plugin / OPENCODE_CONFIG_CONTENT 不动。
