// RFC-023 PR-B T13 — REST endpoints for the clarify feature.
//
//   GET    /api/clarify                       list (filter: status / taskId)
//   GET    /api/clarify/pending-count         { count: N } for left-nav badge
//   GET    /api/clarify/:nodeRunId            session detail (questions + answers JSON)
//   POST   /api/clarify/:nodeRunId/answers    submit user answers
//
// Auth: token middleware applies via createApp's app.use('/api/*', ...).
//
// Optimistic locking: POST honors either an `If-Match` header (integer) or
// the `ifMatchIteration` body field — both translate to ConflictError code
// `clarify-iteration-mismatch` when stale. (Hono auto-maps DomainError to
// 409, not 412; we keep 409 to match the rest of the API surface.)

import { ListClarifyQuerySchema, SubmitClarifyAnswersSchema } from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import { loadConfig } from '@/config'
import { clarifySessions, nodeRuns, tasks as tasksTable } from '@/db/schema'
import type { AppDeps } from '@/server'
import {
  countPendingClarifications,
  getClarifyDetail,
  listClarifySummaries,
  submitClarifyAnswers,
} from '@/services/clarify'
import { isAssignedClarifyTarget } from '@/services/taskCollab'
import { resumeTask } from '@/services/task'
import { Paths } from '@/util/paths'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'
import { createLogger } from '@/util/log'

const log = createLogger('clarify-route')

function resolveOpencodeCmd(configPath: string): string[] | undefined {
  if (configPath === '') return undefined
  try {
    const cfg = loadConfig(configPath)
    if (typeof cfg.opencodePath === 'string' && cfg.opencodePath.length > 0) {
      return [cfg.opencodePath]
    }
  } catch {
    /* nothing */
  }
  return undefined
}

async function ensureClarifyAnswerAuth(
  deps: AppDeps,
  clarifyNodeRunId: string,
  actor: Actor,
): Promise<void> {
  if (actor.permissions.has('tasks:read:all')) return
  // node_runs.id → taskId + nodeId (the clarify node's own id, which is the
  // assignment key on node_assignments).
  const sess = await deps.db
    .select()
    .from(clarifySessions)
    .where(eq(clarifySessions.clarifyNodeRunId, clarifyNodeRunId))
    .limit(1)
  if (!sess[0]) {
    // Fallback to node_runs lookup so the 404 is still correctly attributed.
    const runs = await deps.db
      .select()
      .from(nodeRuns)
      .where(eq(nodeRuns.id, clarifyNodeRunId))
      .limit(1)
    if (!runs[0]) {
      throw new NotFoundError('clarify-session-not-found', 'clarify session not found')
    }
    return // no clarify session yet → service will throw its own error
  }
  const taskRow = (
    await deps.db.select().from(tasksTable).where(eq(tasksTable.id, sess[0].taskId)).limit(1)
  )[0]
  if (!taskRow) {
    throw new NotFoundError('task-not-found', `task '${sess[0].taskId}' not found`)
  }
  if (taskRow.ownerUserId === actor.user.id) return
  if (
    await isAssignedClarifyTarget(deps.db, sess[0].taskId, sess[0].clarifyNodeId, actor.user.id)
  ) {
    return
  }
  throw new ForbiddenError(
    'not-clarify-target',
    'only the assigned clarify target, task owner, or admin can submit this answer',
  )
}

export function mountClarifyRoutes(app: Hono, deps: AppDeps): void {
  app.get('/api/clarify', async (c) => {
    const q = ListClarifyQuerySchema.safeParse({
      status: c.req.query('status') ?? undefined,
      taskId: c.req.query('taskId') ?? c.req.query('task_id') ?? undefined,
      limit: c.req.query('limit') ? Number(c.req.query('limit')) : undefined,
    })
    if (!q.success) {
      throw new ValidationError('clarify-list-query-invalid', 'invalid clarify list query', {
        issues: q.error.issues,
      })
    }
    const filter: {
      status?: typeof q.data.status
      taskId?: string
      limit?: number
    } = {}
    if (q.data.status !== undefined) filter.status = q.data.status
    if (q.data.taskId !== undefined) filter.taskId = q.data.taskId
    if (q.data.limit !== undefined) filter.limit = q.data.limit
    const out = await listClarifySummaries(deps.db, filter)
    return c.json(out)
  })

  app.get('/api/clarify/pending-count', async (c) => {
    const count = await countPendingClarifications(deps.db)
    return c.json({ count })
  })

  app.get('/api/clarify/:nodeRunId', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const detail = await getClarifyDetail(deps.db, nodeRunId)
    return c.json(detail)
  })

  app.post('/api/clarify/:nodeRunId/answers', async (c) => {
    const nodeRunId = c.req.param('nodeRunId')
    const raw: unknown = await c.req.json().catch(() => null)
    const parsed = SubmitClarifyAnswersSchema.safeParse(raw)
    if (!parsed.success) {
      throw new ValidationError('clarify-answers-invalid', 'invalid clarify answers body', {
        issues: parsed.error.issues,
      })
    }
    // Header-based optimistic lock; body field takes precedence if both set.
    let ifMatch = parsed.data.ifMatchIteration
    if (ifMatch === undefined) {
      const header = c.req.header('If-Match')
      if (header !== undefined && /^-?\d+$/.test(header)) {
        ifMatch = Number.parseInt(header, 10)
      }
    }
    // RFC-036: clarify_target / task owner / admin only.
    const actor = actorOf(c)
    await ensureClarifyAnswerAuth(deps, nodeRunId, actor)
    const result = await submitClarifyAnswers({
      db: deps.db,
      clarifyNodeRunId: nodeRunId,
      answers: parsed.data.answers,
      directive: parsed.data.directive,
      answeredBy: actor.user.id,
      ...(ifMatch !== undefined ? { ifMatchIteration: ifMatch } : {}),
    })
    // Re-enter the scheduler so the freshly minted rerun node_run starts.
    //
    // RFC-023 bug 13: when the task is still `running` / `pending` at submit
    // time (typical when there are multiple parallel branches and the user
    // answers one clarify while another branch keeps the scheduler busy),
    // `resumeTask` throws `task-not-resumable`. That used to be swallowed
    // silently and the freshly minted rerun row sat orphaned. Now:
    //   - The scheduler's per-batch rescan (services/scheduler.ts
    //     `rescanScopeForNewPendingRows`) will pick up the new pending row
    //     on its next iteration. So this resume is best-effort.
    //   - We still TRY to resume in case the task is already paused
    //     (awaiting_human / awaiting_review / failed / interrupted), which
    //     covers the single-branch happy path.
    //   - `task-not-resumable` is now logged at info — not silent — so the
    //     deferral is visible in the daemon log if anyone needs to debug.
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    const resumeDeps: Parameters<typeof resumeTask>[2] = {
      db: deps.db,
      appHome: Paths.root,
      ...(opencodeCmd ? { opencodeCmd } : {}),
    }
    void resumeTask(deps.db, result.session.taskId, resumeDeps).catch((err) => {
      if (err instanceof ConflictError && err.code === 'task-not-resumable') {
        log.info('clarify resume deferred — scheduler will rescan mid-batch', {
          taskId: result.session.taskId,
          rerunNodeRunId: result.rerunNodeRunId,
        })
        return
      }
      log.warn('clarify resume threw', {
        taskId: result.session.taskId,
        error: err instanceof Error ? err.message : String(err),
      })
    })
    return c.json({ ok: true, ...result })
  })
}
