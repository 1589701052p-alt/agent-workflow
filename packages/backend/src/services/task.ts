// Task service — start / list / get.
// Cancel/resume/retry land in P-1-15 + M3 (P-3-08, P-3-09).

import type {
  NodeRun,
  NodeRunEvent,
  NodeRunEventsResponse,
  NodeRunOutput,
  StartTask,
  Task,
  TaskDiff,
  TaskNodeRuns,
  TaskSummary,
} from '@agent-workflow/shared'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import { existsSync } from 'node:fs'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRunOutputs, nodeRuns, tasks } from '@/db/schema'
import { getWorkflow } from '@/services/workflow'
import { upsertRecentRepo } from '@/services/repo'
import { createWorktree, rollbackToSnapshot, worktreeDiff } from '@/util/git'
import { ConflictError, DomainError, NotFoundError } from '@/util/errors'
import {
  TASK_CHANNEL,
  TASKS_LIST_CHANNEL,
  taskBroadcaster,
  tasksListBroadcaster,
} from '@/ws/broadcaster'
import { runTask } from './scheduler'
import { Paths } from '@/util/paths'
import { createLogger } from '@/util/log'

const log = createLogger('task')

/**
 * Process-local registry of in-flight task AbortControllers. Used by
 * cancelTask to interrupt the running scheduler/runner pipeline.
 *
 * Survives only within this daemon process. On daemon restart, in-flight
 * tasks are reconciled by the startup orphan scan (P-4-07) — out of scope
 * for M1.
 */
const activeTasks = new Map<string, AbortController>()

export interface StartTaskDeps {
  db: DbClient
  /** Override app home (tests). Defaults to `Paths.root`. */
  appHome?: string
  /** Default per-node timeout (ms). Defaults from settings; tests can pin. */
  defaultPerNodeTimeoutMs?: number
  /** Override opencode command (tests inject mock-opencode). */
  opencodeCmd?: string[]
  /** Await scheduler completion in this call (tests). HTTP route does NOT pass this. */
  awaitScheduler?: boolean
}

export async function startTask(input: StartTask, deps: StartTaskDeps): Promise<Task> {
  // Resolve workflow.
  const workflow = await getWorkflow(deps.db, input.workflowId)
  if (workflow === null) {
    throw new NotFoundError('workflow-not-found', `workflow '${input.workflowId}' not found`)
  }

  const appHome = deps.appHome ?? Paths.root
  const taskId = ulid()

  // Create the worktree. Failure here means we still want a task record so
  // the user sees why their click did nothing (per design.md §6.4).
  let worktreePath = ''
  let branch = ''
  let baseCommit: string | null = null
  let earlyError: string | null = null
  try {
    const wt = await createWorktree({
      repoPath: input.repoPath,
      taskId,
      baseBranch: input.baseBranch,
      appHome,
    })
    worktreePath = wt.worktreePath
    branch = wt.branch
    baseCommit = wt.baseCommit
  } catch (err) {
    earlyError = err instanceof Error ? err.message : String(err)
  }

  const now = Date.now()
  await deps.db.insert(tasks).values({
    id: taskId,
    workflowId: workflow.id,
    workflowSnapshot: JSON.stringify(workflow.definition),
    repoPath: input.repoPath,
    worktreePath,
    baseBranch: input.baseBranch,
    branch: branch !== '' ? branch : `agent-workflow/${taskId}`,
    baseCommit,
    status: earlyError === null ? 'pending' : 'failed',
    inputs: JSON.stringify(input.inputs),
    maxDurationMs: input.maxDurationMs ?? null,
    maxTotalTokens: input.maxTotalTokens ?? null,
    startedAt: now,
    finishedAt: earlyError === null ? null : now,
    errorSummary: earlyError !== null ? `worktree creation failed: ${earlyError}` : null,
    errorMessage: earlyError,
  })

  // Mirror this repo into the recent-repos cache — best-effort, never blocks.
  upsertRecentRepo(deps.db, input.repoPath).catch((err) => {
    log.warn('upsertRecentRepo failed', { error: (err as Error).message })
  })

  const task = (await getTask(deps.db, taskId)) as Task

  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'task.created',
    task: {
      id: task.id,
      workflowId: task.workflowId,
      repoPath: task.repoPath,
      status: task.status,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      errorSummary: task.errorSummary,
    },
  })

  if (earlyError !== null) {
    return task
  }

  // Kick the scheduler. HTTP route returns immediately; tests can await.
  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  const schedulerPromise = runTask({
    taskId,
    db: deps.db,
    appHome,
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
    ...(deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
      : {}),
    log,
    signal: controller.signal,
  })
    .catch((err) => {
      log.error('runTask threw', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      activeTasks.delete(taskId)
    })

  if (deps.awaitScheduler === true) {
    await schedulerPromise
    return (await getTask(deps.db, taskId)) as Task
  }
  return task
}

/**
 * Cancel an in-flight task. Aborts the in-process controller (runner SIGTERMs
 * the opencode child), then waits briefly for the scheduler to settle.
 *
 * Rejects if the task is already terminal.
 */
export async function cancelTask(db: DbClient, id: string): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  if (task.status !== 'pending' && task.status !== 'running') {
    throw new ConflictError(
      'task-not-cancelable',
      `task '${id}' is already ${task.status}; nothing to cancel`,
    )
  }

  const controller = activeTasks.get(id)
  if (controller !== undefined) {
    controller.abort()
    // Wait for the scheduler to record the canceled state (best-effort 5s
    // poll). If the daemon was restarted, no controller exists; we just mark
    // the row canceled directly.
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const reread = await getTask(db, id)
      if (reread !== null && reread.status !== 'pending' && reread.status !== 'running') {
        return reread
      }
      await Bun.sleep(50)
    }
  }

  // Fallback: scheduler didn't notice or no controller — flip the row.
  await db
    .update(tasks)
    .set({
      status: 'canceled',
      finishedAt: Date.now(),
      errorSummary: 'canceled by user',
      errorMessage: 'no active scheduler at cancel time',
    })
    .where(eq(tasks.id, id))
  const final = (await getTask(db, id)) as Task
  emitTaskStatus(final)
  return final
}

/**
 * Resume a failed or interrupted task (P-3-08).
 *
 * Walks all node_runs in failed/interrupted state, rolls the worktree back
 * to each one's pre_snapshot (write nodes only — readers leave the
 * worktree alone), flips the surviving runs back to `pending`, then kicks
 * the scheduler. Done node_runs stay untouched so the resumed task picks
 * up where it left off.
 */
export async function resumeTask(db: DbClient, id: string, deps: StartTaskDeps): Promise<Task> {
  const task = await getTask(db, id)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${id}' not found`)
  }
  if (task.status !== 'failed' && task.status !== 'interrupted') {
    throw new ConflictError(
      'task-not-resumable',
      `task '${id}' is ${task.status}; only failed/interrupted tasks can resume`,
    )
  }

  // Collect the latest non-done run per nodeId — those are the ones that
  // need rollback + a fresh attempt.
  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, id))
  const latestPerNode = new Map<string, (typeof runs)[number]>()
  for (const r of runs) {
    const prev = latestPerNode.get(r.nodeId)
    if (prev === undefined || r.retryIndex > prev.retryIndex) latestPerNode.set(r.nodeId, r)
  }
  const toRollback = [...latestPerNode.values()].filter(
    (r) => r.status === 'failed' || r.status === 'interrupted',
  )

  for (const r of toRollback) {
    if (r.preSnapshot !== null && r.preSnapshot !== '' && task.worktreePath !== '') {
      try {
        await rollbackToSnapshot(task.worktreePath, r.preSnapshot)
      } catch (err) {
        log.warn('resume rollback failed', {
          nodeRunId: r.id,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    // The scheduler creates a new node_run with retry_index = max+1 on its
    // own when it sees no pending run for the node, so we just leave the
    // failed row as historical and clear errors on the task.
  }

  await db
    .update(tasks)
    .set({
      status: 'pending',
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
    })
    .where(eq(tasks.id, id))

  const next = (await getTask(db, id)) as Task
  emitTaskStatus(next)

  // Kick the scheduler — same plumbing as startTask but without re-creating
  // the worktree.
  const controller = new AbortController()
  activeTasks.set(id, controller)
  void runTask({
    taskId: id,
    db,
    appHome: deps.appHome ?? Paths.root,
    ...(deps.opencodeCmd ? { opencodeCmd: deps.opencodeCmd } : {}),
    ...(deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: deps.defaultPerNodeTimeoutMs }
      : {}),
    log,
    signal: controller.signal,
  })
    .catch((err) => {
      log.error('runTask threw on resume', {
        taskId: id,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      activeTasks.delete(id)
    })
  return next
}

/**
 * Retry one node_run, optionally cascading to all downstream nodes that
 * depended on it (P-3-09). The retry happens by:
 *
 *   - rolling the worktree back to the node_run's `pre_snapshot`
 *   - marking the target run + (cascaded) downstream runs as failed so the
 *     scheduler picks them up on the next runTask() invocation
 *   - flipping task.status back to pending
 *   - kicking the scheduler
 */
export async function retryNode(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { cascade?: boolean; deps: StartTaskDeps },
): Promise<Task> {
  const cascade = opts.cascade !== false
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  if (task.status === 'pending' || task.status === 'running') {
    throw new ConflictError(
      'task-still-running',
      `task '${taskId}' is ${task.status}; cancel it first before retrying a node`,
    )
  }
  const runRow = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, nodeRunId)).limit(1))[0]
  if (runRow === undefined || runRow.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }

  // Identify downstream nodeIds from the workflow snapshot's edges.
  const downstream = new Set<string>()
  if (cascade) {
    const snap = parseSnapshot(task.workflowSnapshot)
    const edges = Array.isArray(snap?.edges) ? snap.edges : []
    const adj = new Map<string, string[]>()
    for (const e of edges as Array<{
      source?: { nodeId?: string }
      target?: { nodeId?: string }
    }>) {
      const s = e?.source?.nodeId
      const t = e?.target?.nodeId
      if (typeof s !== 'string' || typeof t !== 'string') continue
      const list = adj.get(s) ?? []
      if (!list.includes(t)) list.push(t)
      adj.set(s, list)
    }
    const stack: string[] = [runRow.nodeId]
    while (stack.length > 0) {
      const cur = stack.pop()!
      for (const next of adj.get(cur) ?? []) {
        if (downstream.has(next)) continue
        downstream.add(next)
        stack.push(next)
      }
    }
  }

  // Rollback to the snapshot before the node_run started. The single-node
  // retry uses THIS run's snapshot (not the latest, since the user picked
  // this specific historical attempt).
  if (runRow.preSnapshot !== null && runRow.preSnapshot !== '' && task.worktreePath !== '') {
    try {
      await rollbackToSnapshot(task.worktreePath, runRow.preSnapshot)
    } catch (err) {
      log.warn('node retry rollback failed', {
        nodeRunId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  // Flip target + downstream node_runs from done → failed so the resumer
  // re-runs them. We do this by inserting a fresh failed row at retry_index
  // max+1, so the scheduler treats it as the "latest" and starts attempt+1.
  const targets = new Set<string>([runRow.nodeId])
  for (const id of downstream) targets.add(id)
  for (const nodeId of targets) {
    const existing = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      .orderBy(desc(nodeRuns.retryIndex))
      .limit(1)
    const prev = existing[0]
    const nextRetry = prev === undefined ? 0 : prev.retryIndex + 1
    const newId = ulid()
    await db.insert(nodeRuns).values({
      id: newId,
      taskId,
      nodeId,
      status: 'failed',
      retryIndex: nextRetry,
      startedAt: Date.now(),
      finishedAt: Date.now(),
      errorMessage: 'queued for retry',
    })
  }

  await db
    .update(tasks)
    .set({
      status: 'pending',
      finishedAt: null,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
    })
    .where(eq(tasks.id, taskId))
  const next = (await getTask(db, taskId)) as Task
  emitTaskStatus(next)

  const controller = new AbortController()
  activeTasks.set(taskId, controller)
  void runTask({
    taskId,
    db,
    appHome: opts.deps.appHome ?? Paths.root,
    ...(opts.deps.opencodeCmd ? { opencodeCmd: opts.deps.opencodeCmd } : {}),
    ...(opts.deps.defaultPerNodeTimeoutMs !== undefined
      ? { defaultPerNodeTimeoutMs: opts.deps.defaultPerNodeTimeoutMs }
      : {}),
    log,
    signal: controller.signal,
  })
    .catch((err) => {
      log.error('runTask threw on node retry', {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    .finally(() => {
      activeTasks.delete(taskId)
    })
  return next
}

function parseSnapshot(v: unknown): Record<string, unknown> | null {
  if (typeof v === 'object' && v !== null) return v as Record<string, unknown>
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>
    } catch {
      return null
    }
  }
  return null
}

/**
 * Push a task-status update onto both broadcaster channels at once.
 * Scheduler + cancel path both call this after each state change.
 */
export function emitTaskStatus(t: Task): void {
  tasksListBroadcaster.broadcast(TASKS_LIST_CHANNEL, {
    type: 'task.status',
    taskId: t.id,
    status: t.status,
  })
  taskBroadcaster.broadcast(TASK_CHANNEL(t.id), {
    id: -1,
    type: 'task.status',
    status: t.status,
    ...(t.errorSummary !== null ? { errorSummary: t.errorSummary } : {}),
  })
  if (
    t.status === 'done' ||
    t.status === 'failed' ||
    t.status === 'canceled' ||
    t.status === 'interrupted'
  ) {
    taskBroadcaster.broadcast(TASK_CHANNEL(t.id), {
      id: -1,
      type: 'task.done',
      status: t.status,
    })
  }
}

export async function getTask(db: DbClient, id: string): Promise<Task | null> {
  const rows = await db.select().from(tasks).where(eq(tasks.id, id)).limit(1)
  const row = rows[0]
  return row ? rowToTask(row) : null
}

export interface ListTasksFilters {
  status?: Task['status']
  workflowId?: string
  repoPath?: string
  limit?: number
}

export async function listTasks(
  db: DbClient,
  filters: ListTasksFilters = {},
): Promise<TaskSummary[]> {
  const conditions = []
  if (filters.status !== undefined) conditions.push(eq(tasks.status, filters.status))
  if (filters.workflowId !== undefined) conditions.push(eq(tasks.workflowId, filters.workflowId))
  if (filters.repoPath !== undefined) conditions.push(eq(tasks.repoPath, filters.repoPath))
  const where =
    conditions.length === 0
      ? undefined
      : conditions.length === 1
        ? conditions[0]
        : and(...conditions)
  const rows = await db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(desc(tasks.startedAt))
    .limit(filters.limit ?? 100)
  return rows.map(rowToSummary)
}

/**
 * Returns all node_runs rows for a task plus their captured port outputs.
 * Ordering: started_at ascending so the frontend can render them as a
 * timeline. node_runs that haven't started yet (`pending`) tail the list
 * sorted by id.
 */
export async function getTaskNodeRuns(db: DbClient, taskId: string): Promise<TaskNodeRuns> {
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  const runRows = await db
    .select()
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
    .orderBy(asc(nodeRuns.startedAt), asc(nodeRuns.id))

  const runs: NodeRun[] = runRows.map((r) => ({
    id: r.id,
    taskId: r.taskId,
    nodeId: r.nodeId,
    parentNodeRunId: r.parentNodeRunId,
    iteration: r.iteration,
    shardKey: r.shardKey,
    retryIndex: r.retryIndex,
    status: r.status,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    pid: r.pid,
    exitCode: r.exitCode,
    errorMessage: r.errorMessage,
    promptText: r.promptText,
    tokInput: r.tokInput,
    tokOutput: r.tokOutput,
    tokTotal: r.tokTotal,
    tokCacheCreate: r.tokCacheCreate,
    tokCacheRead: r.tokCacheRead,
  }))

  let outputs: NodeRunOutput[] = []
  if (runs.length > 0) {
    const runIds = runs.map((r) => r.id)
    const outRows = await db
      .select()
      .from(nodeRunOutputs)
      .where(inArray(nodeRunOutputs.nodeRunId, runIds))
    outputs = outRows.map((o) => ({
      nodeRunId: o.nodeRunId,
      port: o.portName,
      value: o.content,
    }))
  }
  return { runs, outputs }
}

/**
 * Page events for one node_run. `since` is the event id cursor (exclusive);
 * returns up to `limit` events ordered by id ascending plus the new cursor.
 *
 * Caller is responsible for asserting that the task owns the node_run; we
 * just verify the node_run belongs to the task to avoid cross-task leakage.
 */
export async function getNodeRunEvents(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
  opts: { since?: number; limit?: number } = {},
): Promise<NodeRunEventsResponse> {
  const ownerRows = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const owner = ownerRows[0]
  if (owner === undefined || owner.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
  const limit = Math.min(opts.limit ?? 500, 1000)
  const since = opts.since ?? 0
  const rows = await db
    .select()
    .from(nodeRunEvents)
    .where(and(eq(nodeRunEvents.nodeRunId, nodeRunId), gt(nodeRunEvents.id, since)))
    .orderBy(asc(nodeRunEvents.id))
    .limit(limit)

  const events: NodeRunEvent[] = rows.map((r) => {
    let payload: unknown
    try {
      payload = JSON.parse(r.payload)
    } catch {
      payload = r.payload
    }
    return {
      id: r.id,
      nodeRunId: r.nodeRunId,
      ts: r.ts,
      kind: r.kind,
      payload,
    }
  })
  const cursor = events.length > 0 ? (events[events.length - 1]?.id ?? null) : null
  return { events, cursor }
}

/**
 * Concatenated stdout for one node_run (P-3-13). Returns every event's
 * raw `payload` ordered by id ascending, joined with `\n`. Stderr events
 * are excluded — those live on the Events tab.
 */
export async function getNodeRunStdout(
  db: DbClient,
  taskId: string,
  nodeRunId: string,
): Promise<string> {
  const ownerRows = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const owner = ownerRows[0]
  if (owner === undefined || owner.taskId !== taskId) {
    throw new NotFoundError(
      'node-run-not-found',
      `node_run '${nodeRunId}' not found under task '${taskId}'`,
    )
  }
  const rows = await db
    .select({ payload: nodeRunEvents.payload, kind: nodeRunEvents.kind })
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(asc(nodeRunEvents.id))
  return rows
    .filter((r) => r.kind !== 'stderr')
    .map((r) => r.payload)
    .join('\n')
}

/**
 * Cumulative diff in the worktree since the task started.
 *
 * Throws ValidationError if baseCommit wasn't captured (task failed before
 * worktree creation) or if the worktree directory has been removed.
 */
export async function getTaskDiff(db: DbClient, taskId: string): Promise<TaskDiff> {
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }
  if (task.baseCommit === null) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no base commit recorded; cannot compute diff`,
      409,
    )
  }
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute diff`,
      410,
    )
  }
  const { diff, truncated } = await worktreeDiff(task.worktreePath, task.baseCommit)
  return { diff, baseCommit: task.baseCommit, truncated }
}

function rowToTask(row: typeof tasks.$inferSelect): Task {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(row.workflowSnapshot)
  } catch {
    snapshot = null
  }
  let inputs: Record<string, string> = {}
  try {
    inputs = JSON.parse(row.inputs) as Record<string, string>
  } catch {
    inputs = {}
  }
  return {
    id: row.id,
    workflowId: row.workflowId,
    workflowSnapshot: snapshot,
    repoPath: row.repoPath,
    worktreePath: row.worktreePath,
    baseBranch: row.baseBranch,
    branch: row.branch,
    baseCommit: row.baseCommit,
    status: row.status,
    inputs,
    maxDurationMs: row.maxDurationMs,
    maxTotalTokens: row.maxTotalTokens,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
    errorMessage: row.errorMessage,
    failedNodeId: row.failedNodeId,
    expiresAt: row.expiresAt,
    deletedAt: row.deletedAt,
    schemaVersion: row.schemaVersion,
  }
}

function rowToSummary(row: typeof tasks.$inferSelect): TaskSummary {
  return {
    id: row.id,
    workflowId: row.workflowId,
    repoPath: row.repoPath,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    errorSummary: row.errorSummary,
  }
}
