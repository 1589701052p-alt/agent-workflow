// P-4-07: daemon-restart orphan reaping.
//
// When the daemon starts, any task or node_run rows still in `running` are
// orphans from a prior daemon process. We can't tell whether the previous
// process was SIGKILLed (process.kill -0 won't help across PID reuse), so we
// optimistically flip them to `interrupted` and mark the task error so the
// UI shows what happened.
//
// We don't try to attach to old opencode children; if any are still alive,
// they'll keep running detached until they exit naturally (their parent is
// init now). v1 doesn't promise to clean these up.

import { inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'
import { transitionNodeRunStatus, trySetTaskStatus } from '@/services/lifecycle'
import { createLogger } from '@/util/log'

const log = createLogger('orphans')

export interface ReapResult {
  tasks: number
  runs: number
}

export async function reapOrphanRuns(db: DbClient): Promise<ReapResult> {
  const now = Date.now()
  // RFC-097: 'pending' tasks are reaped too — boot runs before the HTTP server
  // listens, so any pending task here is an orphan (startTask inserts and
  // kicks in-process; a resume/retry that crashed mid-rollback leaves the
  // CAS-claimed task pending with nobody attached — the gap5 task-side
  // asymmetry this closes, mirroring the node_runs branch below which always
  // reaped pending rows).
  const runningTasks = await db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ['running', 'pending'] as const))
  const runningRuns = await db
    .select()
    .from(nodeRuns)
    .where(inArray(nodeRuns.status, ['running', 'pending'] as const))

  if (runningTasks.length === 0 && runningRuns.length === 0) {
    return { tasks: 0, runs: 0 }
  }

  for (const t of runningTasks) {
    // RFC-097: CAS from the observed status; a loss means something else
    // already settled the row — skip and log, same net as the node_runs
    // branch below.
    const won = await trySetTaskStatus({
      db,
      taskId: t.id,
      to: 'interrupted',
      allowedFrom: [t.status as 'running' | 'pending'],
      extra: {
        finishedAt: now,
        errorSummary: 'daemon-restart',
        errorMessage: 'daemon restarted while this task was running; please resume',
      },
      reason: 'reapOrphanRuns',
    })
    if (!won) log.warn('orphan task reap lost a race — skipping', { taskId: t.id })
  }
  let runsReaped = 0
  for (const r of runningRuns) {
    try {
      await transitionNodeRunStatus({
        db,
        nodeRunId: r.id,
        event: { kind: 'mark-interrupted' },
        extra: { finishedAt: now },
      })
      runsReaped += 1
    } catch (err) {
      // CAS lost / row already terminal: another writer beat us (e.g.
      // graceful shutdown landed first). Skip silently — orphans reap is
      // best-effort cleanup.
      log.warn('orphan-reap skipped row', {
        nodeRunId: r.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { tasks: runningTasks.length, runs: runsReaped }
}
