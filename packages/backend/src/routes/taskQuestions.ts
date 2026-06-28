// RFC-120 — REST endpoints for the task question list / 任务中心.
//
//   GET  /api/tasks/:id/questions                       list (filter: sourceNodeId / phase)
//   POST /api/tasks/:id/questions/:entryId/confirm      已处理待确认 → 完成
//   POST /api/tasks/:id/questions/:entryId/reassign     改派 designer handler {targetNodeId}
//   POST /api/tasks/:id/questions/:entryId/stage        拖入/出「待下发」{staged}
//
// Auth: token middleware applies via createApp's app.use('/api/*', ...).
// Read inherits task visibility (canViewTask → 404 mirrors task routes); writes
// require task membership (requireTaskMember → 403). The entry must belong to the
// task in the path (cross-task entryId → 404).

import { eq } from 'drizzle-orm'
import type { Context, Hono } from 'hono'
import type { TaskActorRole, TaskQuestionPhase } from '@agent-workflow/shared'
import { actorOf, type Actor } from '@/auth/actor'
import { taskQuestions, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import {
  confirmTaskQuestion,
  listTaskQuestions,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '@/services/taskQuestions'
import { canViewTask, requireTaskMember } from '@/services/taskCollab'
import { NotFoundError, ValidationError } from '@/util/errors'

async function loadVisibleTask(deps: AppDeps, taskId: string, actor: Actor) {
  const [t] = await deps.db.select().from(tasksTable).where(eq(tasksTable.id, taskId)).limit(1)
  if (!t || !(await canViewTask(deps.db, actor, t))) {
    throw new NotFoundError('task-not-found', `task ${taskId} not found`)
  }
  return t
}

/** Member-gated write entry: 404 if task invisible, 403 if not a member, 404 if
 *  the entry belongs to another task. Returns the role snapshot + actor. */
async function gateMemberEntry(
  c: Context,
  deps: AppDeps,
): Promise<{ entryId: string; role: TaskActorRole; actor: Actor }> {
  const taskId = c.req.param('id') ?? ''
  const entryId = c.req.param('entryId') ?? ''
  const actor = actorOf(c)
  const task = await loadVisibleTask(deps, taskId, actor)
  const role = await requireTaskMember(deps.db, actor, task)
  const [e] = await deps.db
    .select({ taskId: taskQuestions.taskId })
    .from(taskQuestions)
    .where(eq(taskQuestions.id, entryId))
    .limit(1)
  if (!e || e.taskId !== taskId) {
    throw new NotFoundError('task-question-not-found', `task question ${entryId} not found`)
  }
  return { entryId, role, actor }
}

export function mountTaskQuestionRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/tasks/:id/questions', async (c) => {
    const taskId = c.req.param('id')
    await loadVisibleTask(deps, taskId, actorOf(c))
    const sourceNodeId = c.req.query('sourceNodeId') || undefined
    const phase = (c.req.query('phase') as TaskQuestionPhase | undefined) || undefined
    return c.json(await listTaskQuestions(deps.db, taskId, { sourceNodeId, phase }))
  })

  app.post('/api/tasks/:id/questions/:entryId/confirm', async (c) => {
    const { entryId, role, actor } = await gateMemberEntry(c, deps)
    await confirmTaskQuestion(deps.db, entryId, { userId: actor.user.id, role })
    return c.json({ ok: true })
  })

  app.post('/api/tasks/:id/questions/:entryId/reassign', async (c) => {
    const { entryId, role, actor } = await gateMemberEntry(c, deps)
    const body = (await c.req.json().catch(() => ({}))) as { targetNodeId?: unknown }
    const targetNodeId = typeof body.targetNodeId === 'string' ? body.targetNodeId : ''
    if (!targetNodeId) {
      throw new ValidationError('target-node-required', 'targetNodeId is required')
    }
    await reassignTaskQuestion(deps.db, entryId, targetNodeId, { userId: actor.user.id, role })
    return c.json({ ok: true })
  })

  app.post('/api/tasks/:id/questions/:entryId/stage', async (c) => {
    const { entryId, role, actor } = await gateMemberEntry(c, deps)
    const body = (await c.req.json().catch(() => ({}))) as { staged?: unknown }
    const staged = body.staged !== false // default true
    await stageTaskQuestion(deps.db, entryId, staged, { userId: actor.user.id, role })
    return c.json({ ok: true })
  })
}
