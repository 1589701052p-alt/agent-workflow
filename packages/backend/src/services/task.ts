// Task service — start / list / get.
// Cancel/resume/retry land in P-1-15 + M3 (P-3-08, P-3-09).

import type { StartTask, Task, TaskSummary } from '@agent-workflow/shared'
import { and, desc, eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { getWorkflow } from '@/services/workflow'
import { upsertRecentRepo } from '@/services/repo'
import { createWorktree } from '@/util/git'
import { ConflictError, NotFoundError } from '@/util/errors'
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
  return (await getTask(db, id)) as Task
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
