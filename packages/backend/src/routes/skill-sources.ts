// RFC-017 skill-source HTTP routes.
//
//   POST   /api/skill-sources               register a parent directory + first scan
//   GET    /api/skill-sources               list with stats
//   PATCH  /api/skill-sources/:id           toggle enabled / rename label
//   DELETE /api/skill-sources/:id           cascade-delete child skills + source row
//   POST   /api/skill-sources/:id/rescan    manual rescan

import {
  CreateSkillSourceSchema,
  UpdateSkillSourceSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import type { AppDeps } from '@/server'
import {
  createSkillSource,
  deleteSkillSource,
  getSkillSourceWithStats,
  listSkillSourcesWithStats,
  rescanSkillSource,
  updateSkillSource,
} from '@/services/skill-source'
import { NotFoundError, ValidationError } from '@/util/errors'

export function mountSkillSourceRoutes(app: Hono, deps: AppDeps): void {
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
    const result = await createSkillSource(deps.db, parsed.data)
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
    const result = await updateSkillSource(deps.db, id, parsed.data)
    const body: { source: typeof result.source; outcome?: typeof result.outcome } = {
      source: result.source,
    }
    if (result.outcome !== undefined) body.outcome = result.outcome
    return c.json(body)
  })

  app.delete('/api/skill-sources/:id', async (c) => {
    await deleteSkillSource(deps.db, c.req.param('id'))
    return c.body(null, 204)
  })

  app.post('/api/skill-sources/:id/rescan', async (c) => {
    const id = c.req.param('id')
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
