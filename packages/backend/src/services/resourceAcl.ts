// RFC-099 — resource-level ownership ACL core.
//
// Five resource types (agent / skill / mcp / plugin / workflow) carry
// owner_user_id + visibility ('private'|'public') columns plus per-user rows
// in resource_grants. This module is the single authority for "can this actor
// see / modify this resource":
//
//   - admins bypass everything. The bypass keys off `actor.user.role` (the
//     identity), NOT the resolved permission set — a PAT with narrowed scopes
//     still belongs to an admin and must not flip row visibility, only route
//     gates (auth/actor.ts buildActor narrows permissions, never the role).
//   - the daemon-token actor is the '__system__' admin, so the runner /
//     scheduler / opencode injection paths are structurally unaffected.
//   - non-granted non-admin users must not observe the resource at all:
//     list endpoints post-filter via filterVisibleRows, detail endpoints turn
//     "not visible" into a 404 (NOT 403 — a 403 would leak existence, D1).
//
// Role snapshots (D7/D17): resolveTaskRole computes the task-relationship
// role recorded on review comments / decisions / clarify submissions. Member
// identity wins over the global admin role.

import type { AclResourceType, ResourceVisibility, TaskActorRole } from '@agent-workflow/shared'
import { and, eq } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { agents, mcps, plugins, resourceGrants, skills, workflows } from '@/db/schema'
import { ForbiddenError, NotFoundError } from '@/util/errors'

/** Minimal row shape every ACL check accepts; full resource rows superset it. */
export interface AclRow {
  id: string
  ownerUserId: string | null
  visibility: ResourceVisibility
}

/** Drizzle table per ACL resource type — used by routes to share generic helpers. */
export const ACL_TABLES = {
  agent: agents,
  skill: skills,
  mcp: mcps,
  plugin: plugins,
  workflow: workflows,
} as const

export function isAdminActor(actor: Actor): boolean {
  return actor.user.role === 'admin'
}

/** All resource ids of `type` granted to this user (one query; empty for admins — they don't need it). */
export async function listGrantedResourceIds(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
): Promise<Set<string>> {
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(and(eq(resourceGrants.resourceType, type), eq(resourceGrants.userId, actor.user.id)))
  return new Set(rows.map((r) => r.resourceId))
}

/** Pure visibility predicate against a pre-fetched grant set. */
export function isVisibleRow(actor: Actor, row: AclRow, grantedIds: ReadonlySet<string>): boolean {
  if (isAdminActor(actor)) return true
  if (row.visibility === 'public') return true
  if (row.ownerUserId !== null && row.ownerUserId === actor.user.id) return true
  return grantedIds.has(row.id)
}

/**
 * Post-filter a full list query down to what the actor may see. One grants
 * query per call; admins short-circuit without touching resource_grants.
 * (List endpoints in this codebase load full tables — system scale is small,
 * so a JS post-filter keeps the five routes uniform; see design §3.)
 */
export async function filterVisibleRows<T extends AclRow>(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  rows: readonly T[],
): Promise<T[]> {
  if (isAdminActor(actor)) return [...rows]
  const granted = await listGrantedResourceIds(db, actor, type)
  return rows.filter((r) => isVisibleRow(actor, r, granted))
}

/** Single-row visibility check (detail / reference sites). */
export async function canViewResource(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<boolean> {
  if (isAdminActor(actor)) return true
  if (row.visibility === 'public') return true
  if (row.ownerUserId !== null && row.ownerUserId === actor.user.id) return true
  const rows = await db
    .select({ resourceId: resourceGrants.resourceId })
    .from(resourceGrants)
    .where(
      and(
        eq(resourceGrants.resourceType, type),
        eq(resourceGrants.resourceId, row.id),
        eq(resourceGrants.userId, actor.user.id),
      ),
    )
    .limit(1)
  return rows.length > 0
}

/**
 * Detail-route gate: invisible → 404 (existence must not leak, D1).
 * Returns void so routes keep their own row object.
 */
export async function requireResourceView(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  if (await canViewResource(db, actor, type, row)) return
  throw new NotFoundError('not-found', `${type} not found`)
}

export function isResourceOwner(actor: Actor, row: AclRow): boolean {
  if (isAdminActor(actor)) return true
  return row.ownerUserId !== null && row.ownerUserId === actor.user.id
}

/**
 * Write-route gate (modify / delete / ACL management): owner or admin.
 * A granted-but-not-owner user CAN see the resource, so a plain 403 here
 * leaks nothing new; an invisible caller still gets the view-404 first
 * (routes call requireResourceView before requireResourceOwner).
 */
export async function requireResourceOwner(
  db: DbClient,
  actor: Actor,
  type: AclResourceType,
  row: AclRow,
): Promise<void> {
  await requireResourceView(db, actor, type, row)
  if (isResourceOwner(actor, row)) return
  throw new ForbiddenError('forbidden', `only the ${type} owner or an admin can modify it`)
}

/**
 * Task-relationship role snapshot (D7/D17) — member identity first:
 *   task owner → 'owner'; collaborator → 'user'; otherwise an admin acting
 *   from outside the membership → 'admin'; anyone else → null (caller must
 *   have rejected already).
 */
export function resolveTaskRole(
  actor: Actor,
  taskOwnerUserId: string | null,
  isMember: boolean,
): TaskActorRole | null {
  if (taskOwnerUserId !== null && taskOwnerUserId === actor.user.id) return 'owner'
  if (isMember) return 'user'
  if (isAdminActor(actor)) return 'admin'
  return null
}
