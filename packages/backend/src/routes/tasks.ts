// GET    /api/tasks                       list (filters via query)
// POST   /api/tasks                       start task; scheduler kicks off in background
// GET    /api/tasks/:id                    full task incl. workflowSnapshot + inputs
// POST   /api/tasks/:id/cancel             abort in-flight task
// GET    /api/tasks/:id/node-runs          per-node run rows + captured outputs
// GET    /api/tasks/:id/diff               cumulative git diff in the worktree
//
// Resume / single-node retry land in M3 (P-3-08, P-3-09).

import { StartTaskSchema, TaskStatusSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  cancelTask,
  getNodeRunEvents,
  getTask,
  getTaskDiff,
  getTaskNodeRuns,
  listTasks,
  resumeTask,
  retryNode,
  startTask,
} from '@/services/task'
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

  app.get('/api/tasks/:id/node-runs', async (c) => {
    return c.json(await getTaskNodeRuns(deps.db, c.req.param('id')))
  })

  app.get('/api/tasks/:id/diff', async (c) => {
    return c.json(await getTaskDiff(deps.db, c.req.param('id')))
  })

  app.post('/api/tasks/:id/resume', async (c) => {
    const task = await resumeTask(deps.db, c.req.param('id'), { db: deps.db })
    return c.json(task)
  })

  app.post('/api/tasks/:id/nodes/:nodeRunId/retry', async (c) => {
    const cascadeRaw = c.req.query('cascade')
    const cascade = cascadeRaw === undefined ? true : cascadeRaw !== 'false'
    const task = await retryNode(deps.db, c.req.param('id'), c.req.param('nodeRunId'), {
      cascade,
      deps: { db: deps.db },
    })
    return c.json(task)
  })

  app.get('/api/tasks/:id/node-runs/:nodeRunId/events', async (c) => {
    const sinceRaw = c.req.query('since')
    const limitRaw = c.req.query('limit')
    const opts: { since?: number; limit?: number } = {}
    if (sinceRaw !== undefined) {
      const n = Number(sinceRaw)
      if (!Number.isFinite(n) || n < 0) {
        throw new ValidationError('events-since-invalid', `since must be a non-negative number`)
      }
      opts.since = n
    }
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isFinite(n) || n <= 0) {
        throw new ValidationError('events-limit-invalid', `limit must be a positive number`)
      }
      opts.limit = n
    }
    return c.json(
      await getNodeRunEvents(deps.db, c.req.param('id'), c.req.param('nodeRunId'), opts),
    )
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
