// RFC-159 — scheduled-task HTTP routes.
// GET    /api/scheduled-tasks       — list (owner + tasks:read:all admin see all)
// GET    /api/scheduled-tasks/:id   — one (invisible == 404)
// POST   /api/scheduled-tasks       — create (owner = actor; create-time launch gate)
// PUT    /api/scheduled-tasks/:id   — update (owner/admin)
// DELETE /api/scheduled-tasks/:id   — delete (owner/admin)
//
// Member-based-private like tasks (owner_user_id + tasks:read:all admin bypass),
// NOT the RFC-099 five-type ACL. Run history for a schedule = its launched tasks
// via GET /api/tasks?scheduledTaskId= (see routes/tasks.ts).
import { CreateScheduledTaskSchema, UpdateScheduledTaskSchema } from '@agent-workflow/shared'
import type { ScheduledTask } from '@agent-workflow/shared'
import type { Hono } from 'hono'

import { actorOf, SYSTEM_USER_ID, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  createScheduledTask,
  deleteScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
} from '@/services/scheduledTasks'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

/** Read visibility: admins (tasks:read:all) see all; otherwise owner only. */
function canViewScheduledTask(actor: Actor, row: ScheduledTask): boolean {
  if (actor.permissions.has('tasks:read:all')) return true
  if (row.ownerUserId === actor.user.id) return true
  if (row.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) return true
  return false
}

/** Write authority: owner or an admin. */
function requireWriteAccess(actor: Actor, row: ScheduledTask): void {
  if (row.ownerUserId === actor.user.id) return
  if (actor.user.role === 'admin') return
  throw new ForbiddenError('scheduled-task-forbidden', `not permitted to modify '${row.id}'`)
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    throw new ValidationError('invalid-json', 'request body is not valid JSON')
  }
}

async function loadVisible(deps: AppDeps, actor: Actor, id: string): Promise<ScheduledTask> {
  const row = await getScheduledTask(deps.db, id)
  // Invisible == missing (same 404) so a non-owner can't probe existence.
  if (row === null || !canViewScheduledTask(actor, row)) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  return row
}

export function mountScheduledTaskRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/scheduled-tasks', async (c) => {
    const actor = actorOf(c)
    const all = await listScheduledTasks(deps.db)
    return c.json(all.filter((row) => canViewScheduledTask(actor, row)))
  })

  app.get('/api/scheduled-tasks/:id', async (c) => {
    return c.json(await loadVisible(deps, actorOf(c), c.req.param('id')))
  })

  app.post('/api/scheduled-tasks', async (c) => {
    const parsed = CreateScheduledTaskSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('scheduled-task-invalid', 'invalid scheduled task', {
        issues: parsed.error.issues,
      })
    }
    const created = await createScheduledTask(deps.db, parsed.data, { actor: actorOf(c) })
    return c.json(created, 201)
  })

  app.put('/api/scheduled-tasks/:id', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisible(deps, actor, c.req.param('id'))
    requireWriteAccess(actor, existing)
    const parsed = UpdateScheduledTaskSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('scheduled-task-invalid', 'invalid scheduled task patch', {
        issues: parsed.error.issues,
      })
    }
    const updated = await updateScheduledTask(deps.db, existing.id, parsed.data, { actor })
    return c.json(updated)
  })

  app.delete('/api/scheduled-tasks/:id', async (c) => {
    const actor = actorOf(c)
    const existing = await loadVisible(deps, actor, c.req.param('id'))
    requireWriteAccess(actor, existing)
    await deleteScheduledTask(deps.db, existing.id)
    return c.body(null, 204)
  })
}
