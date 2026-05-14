// GET    /api/tasks                  list (filters via query)
// POST   /api/tasks                  start task; scheduler kicks off in background
// GET    /api/tasks/:id               full task incl. workflowSnapshot + inputs
//
// Cancel / resume / single-node retry / detail with node-run drill-in land
// in subsequent issues (P-1-15, P-3-08, P-3-09, P-2-12).

import { StartTaskSchema, TaskStatusSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import { cancelTask, getTask, listTasks, startTask } from '@/services/task'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountTaskRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks', async (c) => {
    const filters: Parameters<typeof listTasks>[1] = {}
    const status = c.req.query('status')
    if (status !== undefined) {
      const parsed = TaskStatusSchema.safeParse(status)
      if (!parsed.success) {
        throw new ValidationError('task-filter-invalid', `unknown status: ${status}`)
      }
      filters.status = parsed.data
    }
    const workflowId = c.req.query('workflow_id') ?? c.req.query('workflowId')
    if (workflowId !== undefined && workflowId !== '') filters.workflowId = workflowId
    const repoPath = c.req.query('repo_path') ?? c.req.query('repoPath')
    if (repoPath !== undefined && repoPath !== '') filters.repoPath = repoPath
    const limit = c.req.query('limit')
    if (limit !== undefined) {
      const n = Number(limit)
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('task-filter-invalid', `limit must be a positive number`)
      }
      filters.limit = Math.min(n, 500)
    }
    return c.json(await listTasks(deps.db, filters))
  })

  app.get('/api/tasks/:id', async (c) => {
    const task = await getTask(deps.db, c.req.param('id'))
    if (task === null) {
      throw new NotFoundError('task-not-found', `task '${c.req.param('id')}' not found`)
    }
    return c.json(task)
  })

  app.post('/api/tasks', async (c) => {
    const parsed = StartTaskSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('task-invalid', 'invalid task payload', {
        issues: parsed.error.issues,
      })
    }
    const task = await startTask(parsed.data, { db: deps.db })
    return c.json(task, 201)
  })

  app.post('/api/tasks/:id/cancel', async (c) => {
    const task = await cancelTask(deps.db, c.req.param('id'))
    return c.json(task)
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
