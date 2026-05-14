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

import { eq, inArray } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns, tasks } from '@/db/schema'

export interface ReapResult {
  tasks: number
  runs: number
}

export async function reapOrphanRuns(db: DbClient): Promise<ReapResult> {
  const now = Date.now()
  const runningTasks = await db.select().from(tasks).where(eq(tasks.status, 'running'))
  const runningRuns = await db
    .select()
    .from(nodeRuns)
    .where(inArray(nodeRuns.status, ['running', 'pending'] as const))

  if (runningTasks.length === 0 && runningRuns.length === 0) {
    return { tasks: 0, runs: 0 }
  }

  for (const t of runningTasks) {
    await db
      .update(tasks)
      .set({
        status: 'interrupted',
        finishedAt: now,
        errorSummary: 'daemon-restart',
        errorMessage: 'daemon restarted while this task was running; please resume',
      })
      .where(eq(tasks.id, t.id))
  }
  for (const r of runningRuns) {
    await db
      .update(nodeRuns)
      .set({ status: 'interrupted', finishedAt: now })
      .where(eq(nodeRuns.id, r.id))
  }
  return { tasks: runningTasks.length, runs: runningRuns.length }
}
