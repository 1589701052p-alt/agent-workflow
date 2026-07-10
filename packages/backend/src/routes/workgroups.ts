// Workgroup HTTP routes (RFC-164 PR-1).
// GET    /api/workgroups                — list (ACL-filtered)
// GET    /api/workgroups/:name          — one (invisible → 404, D1)
// POST   /api/workgroups                — create (creator becomes owner)
// PUT    /api/workgroups/:name          — full-document update (members full-replace)
// DELETE /api/workgroups/:name          — delete (tasks keep their config snapshot)
// POST   /api/workgroups/:name/rename   — rename (nothing references by name)
// GET/PUT /api/workgroups/:name/acl     — RFC-099 ACL management
//
// RFC-099 D15: creating/updating checks that NEW agent-member references are
// usable by the editor (assertNewRefsUsable) — dangling names still pass
// (existence is launch-validated, same as workflow agentName).

import {
  CreateWorkgroupSchema,
  RenameWorkgroupSchema,
  UpdateWorkgroupSchema,
} from '@agent-workflow/shared'
import type { Hono } from 'hono'
import { actorOf, type Actor } from '@/auth/actor'
import type { AppDeps } from '@/server'
import { canViewResource, filterVisibleRows, requireResourceOwner } from '@/services/resourceAcl'
import { assertNewRefsUsable } from '@/services/resourceRefs'
import {
  createWorkgroup,
  deleteWorkgroup,
  diffNewAgentMemberNames,
  getWorkgroup,
  listWorkgroups,
  renameWorkgroup,
  updateWorkgroup,
} from '@/services/workgroups'
import { NotFoundError, ValidationError } from '@/util/errors'
import { mountAclEndpoints } from './resourceAcl'

export function mountWorkgroupRoutes(app: Hono, deps: AppDeps): void {
  // RFC-099: missing and not-visible produce the identical 404 (D1).
  async function loadVisibleWorkgroup(actor: Actor, name: string) {
    const group = await getWorkgroup(deps.db, name)
    if (group === null || !(await canViewResource(deps.db, actor, 'workgroup', group))) {
      throw new NotFoundError('workgroup-not-found', `workgroup '${name}' not found`)
    }
    return group
  }

  app.get('/api/workgroups', async (c) => {
    const list = await listWorkgroups(deps.db)
    return c.json(await filterVisibleRows(deps.db, actorOf(c), 'workgroup', list))
  })

  app.get('/api/workgroups/:name', async (c) => {
    return c.json(await loadVisibleWorkgroup(actorOf(c), c.req.param('name')))
  })

  app.post('/api/workgroups', async (c) => {
    const body = await safeJson(c.req.raw)
    const parsed = CreateWorkgroupSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'agent', names: diffNewAgentMemberNames(null, parsed.data) },
    ])
    const created = await createWorkgroup(deps.db, parsed.data, { ownerUserId: actor.user.id })
    return c.json(created, 201)
  })

  app.put('/api/workgroups/:name', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = UpdateWorkgroupSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-invalid', 'invalid workgroup payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleWorkgroup(actor, name)
    await requireResourceOwner(deps.db, actor, 'workgroup', existing)
    // D15: only NEW agent references need to be usable by the editor.
    await assertNewRefsUsable(deps.db, actor, [
      { type: 'agent', names: diffNewAgentMemberNames(existing, parsed.data) },
    ])
    const updated = await updateWorkgroup(deps.db, name, parsed.data)
    return c.json(updated)
  })

  app.delete('/api/workgroups/:name', async (c) => {
    const name = c.req.param('name')
    const actor = actorOf(c)
    const existing = await loadVisibleWorkgroup(actor, name)
    await requireResourceOwner(deps.db, actor, 'workgroup', existing)
    await deleteWorkgroup(deps.db, name)
    return c.body(null, 204)
  })

  app.post('/api/workgroups/:name/rename', async (c) => {
    const name = c.req.param('name')
    const body = await safeJson(c.req.raw)
    const parsed = RenameWorkgroupSchema.safeParse(body)
    if (!parsed.success) {
      throw new ValidationError('workgroup-rename-invalid', 'invalid rename payload', {
        issues: parsed.error.issues,
      })
    }
    const actor = actorOf(c)
    const existing = await loadVisibleWorkgroup(actor, name)
    await requireResourceOwner(deps.db, actor, 'workgroup', existing)
    const renamed = await renameWorkgroup(deps.db, name, parsed.data.newName)
    return c.json(renamed)
  })

  // RFC-099 — GET/PUT /api/workgroups/:name/acl
  mountAclEndpoints(app, deps, {
    type: 'workgroup',
    base: '/api/workgroups',
    param: 'name',
    load: (db, name) => getWorkgroup(db, name),
  })
}

async function safeJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return {}
  }
}
