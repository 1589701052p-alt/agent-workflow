// RFC-159 — the launch closure shared by the scheduled-task loop (cli/start.ts)
// and the manual run-now route. Kept in its own tiny module so it can import
// startTask (a VALUE) without dragging services/task.ts into an import cycle:
// nothing that task.ts imports transitively reaches here.
import type { DbClient } from '@/db/client'
import type { BuildScheduleLaunch } from '@/services/scheduledTasks'
import { buildStartTaskDeps } from '@/services/startTaskDeps'
import { startTask } from '@/services/task'

/**
 * `(ownerUserId, scheduledTaskId) => (body) => startTask(body, deps)` — builds the
 * launch deps live (so scheduled / manual launches match a manual UI launch) and
 * stamps `tasks.scheduled_task_id` for run-history attribution.
 */
export function buildScheduleLaunch(db: DbClient, configPath: string): BuildScheduleLaunch {
  return (ownerUserId, scheduledTaskId) => async (body) => {
    const task = await startTask(body, {
      ...buildStartTaskDeps(db, configPath, ownerUserId),
      scheduledTaskId,
    })
    return { id: task.id }
  }
}
