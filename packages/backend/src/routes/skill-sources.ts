// RFC-017 skill-source HTTP routes.
//
//   POST   /api/skill-sources               register a parent directory + first scan
//   GET    /api/skill-sources               list with stats
//   PATCH  /api/skill-sources/:id           toggle enabled / rename label
//   DELETE /api/skill-sources/:id           cascade-delete child skills + source row
//   POST   /api/skill-sources/:id/rescan    manual rescan

import { CreateSkillSourceSchema, UpdateSkillSourceSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { isAdminActor } from '@/services/resourceAcl'
import {
  createSkillSource,
  deleteSkillSource,
  getSkillSourceWithStats,
  listSkillSourcesWithStats,
  rescanSkillSource,
  updateSkillSource,
} from '@/services/skill-source'
import { ForbiddenError, NotFoundError, ValidationError } from '@/util/errors'

export function mountSkillSourceRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099 (D11): every user may register a source; mutating an existing one
  // is reserved for its registrar (created_by) or an admin. Sources predating
  // RFC-099 (created_by NULL) stay admin-managed.
  async function requireSourceRegistrar(actor: Actor, id: string) {
    const source = await getSkillSourceWithStats(deps.db, id)
    if (source === null) {
      throw new NotFoundError('skill-source-not-found', `source '${id}' not found`)
    }
    if (isAdminActor(actor)) return
    if (source.createdBy != null && source.createdBy === actor.user.id) return
    throw new ForbiddenError(
      'forbidden',
      'only the source registrar or an admin can modify this source',
    )
  }

  app.get('/api/skill-sources', async (c) => {
    const sources = await listSkillSourcesWithStats(deps.db)
    return c.json({ sources })
  })

  app.post('/api/skill-sources', async (c) => {
    const parsed = CreateSkillSourceSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-source-invalid', 'invalid skill source payload', {
        issues: parsed.error.issues,
      })
    }
    const result = await createSkillSource(deps.db, parsed.data, {
      createdBy: actorOf(c).user.id,
    })
    return c.json(
      {
        source: result.source,
        imported: result.outcome.imported,
        skipped: result.outcome.skipped,
      },
      201,
    )
  })

  app.patch('/api/skill-sources/:id', async (c) => {
    const parsed = UpdateSkillSourceSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('skill-source-invalid', 'invalid skill source patch', {
        issues: parsed.error.issues,
      })
    }
    const id = c.req.param('id')
    await requireSourceRegistrar(actorOf(c), id)
    const result = await updateSkillSource(deps.db, id, parsed.data)
    const body: { source: typeof result.source; outcome?: typeof result.outcome } = {
      source: result.source,
    }
    if (result.outcome !== undefined) body.outcome = result.outcome
    return c.json(body)
  })

  app.delete('/api/skill-sources/:id', async (c) => {
    await requireSourceRegistrar(actorOf(c), c.req.param('id'))
    await deleteSkillSource(deps.db, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/skill-sources/:id/rescan', async (c) => {
    const id = c.req.param('id')
    await requireSourceRegistrar(actorOf(c), id)
    const outcome = await rescanSkillSource(deps.db, id)
    const source = await getSkillSourceWithStats(deps.db, id)
    if (source === null) {
      throw new NotFoundError('skill-source-not-found', `source '${id}' not found`)
    }
    return c.json({
      source,
      imported: outcome.imported,
      deleted: outcome.deleted,
      skipped: outcome.skipped,
    })
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
