// RFC-101 — memory→skill fusion HTTP routes.
//
//   POST   /api/fusions                 launch a fusion (skill + memories + intent)
//   GET    /api/fusions?skillName=       list (own + admin-all)
//   GET    /api/fusions/:id              detail (owner / admin)
//   POST   /api/fusions/:id/approve      apply the proposed change
//   POST   /api/fusions/:id/reject       request changes + re-run
//   POST   /api/fusions/:id/cancel       cancel
//
// Authentication is the /api/* multiAuth gate; per-fusion authorization (skill
// write, memory manage, fusion ownership) is enforced in services/fusion.ts.

import { LaunchFusionSchema, RejectFusionSchema } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  approveFusion,
  cancelFusion,
  createFusion,
  getFusion,
  listFusions,
  rejectFusion,
  type FusionDeps,
} from '@/services/fusion'
import { loadConfig } from '@/config'
import { isAdminActor } from '@/services/resourceAcl'
import { NotFoundError, ValidationError } from '@/util/errors'
import { Paths } from '@/util/paths'

function resolveOpencodeCmd(configPath: string): string[] | undefined {
  try {
    const cfg = loadConfig(configPath)
    if (typeof cfg.opencodePath === 'string' && cfg.opencodePath.length > 0) {
      return [cfg.opencodePath]
    }
  } catch {
    // config unreadable — fall back to default PATH lookup
  }
  return undefined
}

export function mountFusionRoutes(app: Hono, deps: AppDeps): void {
  function fusionDeps(): FusionDeps {
    const opencodeCmd = resolveOpencodeCmd(deps.configPath)
    return { db: deps.db, appHome: Paths.root, ...(opencodeCmd ? { opencodeCmd } : {}) }
  }

  app.post('/api/fusions', async (c) => {
    const parsed = LaunchFusionSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('fusion-invalid', 'invalid fusion payload', {
        issues: parsed.error.issues,
      })
    }
    const fusion = await createFusion(parsed.data, fusionDeps(), actorOf(c))
    return c.json(fusion, 201)
  })

  app.get('/api/fusions', async (c) => {
    const actor = actorOf(c)
    const skillName = c.req.query('skillName')
    const all = await listFusions(fusionDeps(), skillName ? { skillName } : {})
    const visible = isAdminActor(actor) ? all : all.filter((f) => f.ownerUserId === actor.user.id)
    return c.json(visible)
  })

  app.get('/api/fusions/:id', async (c) => {
    const actor = actorOf(c)
    const fusion = await getFusion(fusionDeps(), c.req.param('id'))
    // RFC-099-style existence isolation: not-owner / not-found are identical.
    if (fusion === null || (!isAdminActor(actor) && fusion.ownerUserId !== actor.user.id)) {
      throw new NotFoundError('fusion-not-found', `fusion '${c.req.param('id')}' not found`)
    }
    return c.json(fusion)
  })

  app.post('/api/fusions/:id/approve', async (c) => {
    return c.json(await approveFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
  })

  app.post('/api/fusions/:id/reject', async (c) => {
    const parsed = RejectFusionSchema.safeParse(await safeJson(c.req.raw))
    if (!parsed.success) {
      throw new ValidationError('fusion-reject-invalid', 'invalid reject payload', {
        issues: parsed.error.issues,
      })
    }
    return c.json(
      await rejectFusion(fusionDeps(), c.req.param('id'), parsed.data.feedback, actorOf(c)),
    )
  })

  app.post('/api/fusions/:id/cancel', async (c) => {
    return c.json(await cancelFusion(fusionDeps(), c.req.param('id'), actorOf(c)))
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
