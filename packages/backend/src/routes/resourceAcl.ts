// RFC-099 — generic GET/PUT /api/{resource}/:key/acl endpoints, mounted once
// per resource by the five resource route modules. The route gate
// (resourcePermissionGate in server.ts) already maps GET→{res}:read and
// PUT→{res}:write; per-row owner enforcement happens in updateResourceAcl.
//
// "Row missing" and "row invisible" deliberately produce the SAME 404 payload
// so a non-granted user cannot probe existence (D1).

import { UpdateResourceAclBodySchema, type AclResourceType } from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf } from '@/auth/actor'
import type { AppDeps } from '@/server'
import {
  canViewResource,
  getResourceAcl,
  updateResourceAcl,
  type AclRow,
} from '@/services/resourceAcl'
import { NotFoundError, ValidationError } from '@/util/errors'
import { WORKFLOWS_CHANNEL, workflowsBroadcaster } from '@/ws/broadcaster'

export interface AclEndpointConfig {
  type: AclResourceType
  /** e.g. '/api/agents' */
  base: string
  /** route param name: 'name' (agents/skills/mcps) or 'id' (plugins/workflows) */
  param: 'name' | 'id'
  /** Load the row by the route key; null when absent. */
  load: (db: AppDeps['db'], key: string) => Promise<AclRow | null>
}

export function mountAclEndpoints(app: Hono, deps: AppDeps, cfg: AclEndpointConfig): void {
  const path = `${cfg.base}/:${cfg.param}/acl`

  app.get(path, async (c) => {
    const key = c.req.param(cfg.param) ?? ''
    const actor = actorOf(c)
    const row = await cfg.load(deps.db, key)
    if (row === null || !(await canViewResource(deps.db, actor, cfg.type, row))) {
      throw new NotFoundError(`${cfg.type}-not-found`, `${cfg.type} '${key}' not found`)
    }
    return c.json(await getResourceAcl(deps.db, actor, cfg.type, row))
  })

  app.put(path, async (c) => {
    const key = c.req.param(cfg.param) ?? ''
    const actor = actorOf(c)
    const row = await cfg.load(deps.db, key)
    if (row === null || !(await canViewResource(deps.db, actor, cfg.type, row))) {
      throw new NotFoundError(`${cfg.type}-not-found`, `${cfg.type} '${key}' not found`)
    }
    const body: unknown = await c.req.json().catch(() => ({}))
    const parsed = UpdateResourceAclBodySchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('acl-invalid', 'invalid acl payload', {
        issues: parsed.error.issues,
      })
    }
    const result = await updateResourceAcl(deps.db, actor, cfg.type, row, parsed.data)
    if (cfg.type === 'workflow') {
      // Lets connected /ws/workflows clients re-fetch AND lets the WS server
      // invalidate its per-connection visibility cache for this workflow.
      workflowsBroadcaster.broadcast(WORKFLOWS_CHANNEL, {
        type: 'workflow.acl.updated',
        workflowId: row.id,
      })
    }
    return c.json(result)
  })
}
