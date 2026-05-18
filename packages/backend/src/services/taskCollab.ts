// RFC-036 — task collaboration service. PR2 scope: visibility helpers + the
// minimum reads needed for routes/tasks.ts and routes/reviews.ts to gate
// access. PR4 layers in launcher-side writes (recordAssignments,
// recordCollaborators, changeAssignment).

import { and, eq } from 'drizzle-orm'
import type { NodeAssignmentInput } from '@agent-workflow/shared'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { tasks } from '@/db/schema'
import { nodeAssignments, taskCollaborators, users } from '@/db/schema'
import { ValidationError } from '@/util/errors'

/** Row-shape that visibility checks accept. The full `tasks` row is supersets of this. */
export type TaskRowForVisibility = Pick<typeof tasks.$inferSelect, 'id' | 'ownerUserId'>

/**
 * Pure read: is the actor allowed to see this task?
 * - admins (tasks:read:all) see everything;
 * - owner sees their own;
 * - any collaborator role sees the task;
 * - daemon-token actor (__system__) sees everything via tasks:read:all.
 */
export async function canViewTask(
  db: DbClient,
  actor: Actor,
  task: TaskRowForVisibility,
): Promise<boolean> {
  if (actor.permissions.has('tasks:read:all')) return true
  if (task.ownerUserId && task.ownerUserId === actor.user.id) return true
  if (task.ownerUserId === SYSTEM_USER_ID && actor.user.id === SYSTEM_USER_ID) return true
  return hasMembership(db, task.id, actor.user.id)
}

export async function hasMembership(
  db: DbClient,
  taskId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(taskCollaborators)
    .where(and(eq(taskCollaborators.taskId, taskId), eq(taskCollaborators.userId, userId)))
    .limit(1)
  return rows.length > 0
}

export async function listCollaborators(
  db: DbClient,
  taskId: string,
): Promise<(typeof taskCollaborators.$inferSelect)[]> {
  return db.select().from(taskCollaborators).where(eq(taskCollaborators.taskId, taskId))
}

export async function listAssignments(
  db: DbClient,
  taskId: string,
): Promise<(typeof nodeAssignments.$inferSelect)[]> {
  return db.select().from(nodeAssignments).where(eq(nodeAssignments.taskId, taskId))
}

/**
 * PR4 will replace this with reviewer / clarify_target lookup; PR2 only needs
 * the visibility gate + the helper signature for routes/reviews.ts so the
 * "owner / admin" fallback compiles. The node-level check returns null if
 * there is no assignment row yet (legacy task launched pre-RFC-036).
 */
export async function getNodeAssignment(
  db: DbClient,
  taskId: string,
  nodeId: string,
  kind: 'reviewer' | 'clarify_target',
): Promise<typeof nodeAssignments.$inferSelect | null> {
  const rows = await db
    .select()
    .from(nodeAssignments)
    .where(
      and(
        eq(nodeAssignments.taskId, taskId),
        eq(nodeAssignments.nodeId, nodeId),
        eq(nodeAssignments.kind, kind),
      ),
    )
    .limit(1)
  return rows[0] ?? null
}

export async function isAssignedReviewer(
  db: DbClient,
  taskId: string,
  nodeId: string,
  userId: string,
): Promise<boolean> {
  const row = await getNodeAssignment(db, taskId, nodeId, 'reviewer')
  return row?.userId === userId
}

export async function isAssignedClarifyTarget(
  db: DbClient,
  taskId: string,
  nodeId: string,
  userId: string,
): Promise<boolean> {
  const row = await getNodeAssignment(db, taskId, nodeId, 'clarify_target')
  return row?.userId === userId
}

/**
 * Pure function — validates the assignments[] payload against the workflow
 * definition. Throws ValidationError with code='invalid-assignment' if any
 * row references a non-existent node, has a kind that doesn't match the
 * node kind, or appears twice. Caller is responsible for the userId active
 * check (DB lookup).
 */
export function ensureValidAssignments(
  workflowDef: { nodes?: ReadonlyArray<{ id?: string; kind?: string }> } | null | undefined,
  items: ReadonlyArray<NodeAssignmentInput>,
): void {
  const nodeKindById = new Map<string, string>()
  for (const n of workflowDef?.nodes ?? []) {
    if (typeof n.id === 'string' && typeof n.kind === 'string') {
      nodeKindById.set(n.id, n.kind)
    }
  }
  const seen = new Set<string>()
  for (const a of items) {
    const key = `${a.nodeId}::${a.kind}`
    if (seen.has(key)) {
      throw new ValidationError(
        'invalid-assignment',
        `duplicate assignment for nodeId='${a.nodeId}' kind='${a.kind}'`,
      )
    }
    seen.add(key)
    const nodeKind = nodeKindById.get(a.nodeId)
    if (nodeKind === undefined) {
      throw new ValidationError(
        'invalid-assignment',
        `assignment refers to unknown nodeId='${a.nodeId}'`,
      )
    }
    if (a.kind === 'reviewer' && nodeKind !== 'review') {
      throw new ValidationError(
        'invalid-assignment',
        `assignment kind='reviewer' incompatible with node kind='${nodeKind}'`,
      )
    }
    if (a.kind === 'clarify_target' && nodeKind !== 'clarify') {
      throw new ValidationError(
        'invalid-assignment',
        `assignment kind='clarify_target' incompatible with node kind='${nodeKind}'`,
      )
    }
  }
}

/**
 * Persist a task's launch-time owner / assignments / collaborators. Caller has
 * already inserted the `tasks` row (so taskCollaborators FKs resolve) — this
 * just writes the supporting rows.
 */
export async function recordLaunchContext(
  db: DbClient,
  args: {
    taskId: string
    ownerUserId: string
    assignments: ReadonlyArray<NodeAssignmentInput>
    collaboratorUserIds: ReadonlyArray<string>
    now: number
  },
): Promise<void> {
  // 1. Validate every referenced user is active.
  const referenced = new Set<string>()
  referenced.add(args.ownerUserId)
  for (const a of args.assignments) referenced.add(a.userId)
  for (const u of args.collaboratorUserIds) referenced.add(u)
  if (referenced.size > 0) {
    const ids = [...referenced]
    const rows = await db.select().from(users)
    const active = new Set(rows.filter((r) => r.status === 'active').map((r) => r.id))
    for (const id of ids) {
      if (!active.has(id)) {
        throw new ValidationError('invalid-assignment', `referenced user '${id}' is not active`)
      }
    }
  }

  // 2. Insert owner row + collaborator + per-assignment rows in a single batch.
  // SQLite primary-key conflict ignored on duplicate (owner==collaborator).
  const collabValues: (typeof taskCollaborators.$inferInsert)[] = []
  collabValues.push({
    taskId: args.taskId,
    userId: args.ownerUserId,
    role: 'owner',
    addedBy: args.ownerUserId,
    addedAt: args.now,
  })
  for (const u of args.collaboratorUserIds) {
    if (u === args.ownerUserId) continue
    collabValues.push({
      taskId: args.taskId,
      userId: u,
      role: 'collaborator',
      addedBy: args.ownerUserId,
      addedAt: args.now,
    })
  }
  for (const a of args.assignments) {
    collabValues.push({
      taskId: args.taskId,
      userId: a.userId,
      role: a.kind === 'reviewer' ? 'reviewer' : 'clarify_target',
      addedBy: args.ownerUserId,
      addedAt: args.now,
    })
  }
  // de-dup by (taskId, userId, role) to satisfy the composite PK.
  const seenPK = new Set<string>()
  const insertCollab = collabValues.filter((v) => {
    const key = `${v.taskId}::${v.userId}::${v.role}`
    if (seenPK.has(key)) return false
    seenPK.add(key)
    return true
  })
  if (insertCollab.length > 0) {
    await db.insert(taskCollaborators).values(insertCollab)
  }
  if (args.assignments.length > 0) {
    await db.insert(nodeAssignments).values(
      args.assignments.map((a) => ({
        taskId: args.taskId,
        nodeId: a.nodeId,
        kind: a.kind,
        userId: a.userId,
        assignedBy: args.ownerUserId,
        assignedAt: args.now,
      })),
    )
  }
}

/** RFC-036 PATCH `/api/tasks/:id/assignments/:nodeId`. */
export async function changeNodeAssignment(
  db: DbClient,
  args: {
    taskId: string
    nodeId: string
    kind: 'reviewer' | 'clarify_target'
    newUserId: string
    actorId: string
    now: number
  },
): Promise<void> {
  // Validate new user is active.
  const rows = await db.select().from(users).where(eq(users.id, args.newUserId)).limit(1)
  if (!rows[0] || rows[0].status !== 'active') {
    throw new ValidationError(
      'invalid-assignment',
      `referenced user '${args.newUserId}' is not active`,
    )
  }
  const existing = await getNodeAssignment(db, args.taskId, args.nodeId, args.kind)
  if (existing) {
    await db
      .update(nodeAssignments)
      .set({ userId: args.newUserId, assignedBy: args.actorId, assignedAt: args.now })
      .where(
        and(
          eq(nodeAssignments.taskId, args.taskId),
          eq(nodeAssignments.nodeId, args.nodeId),
          eq(nodeAssignments.kind, args.kind),
        ),
      )
  } else {
    await db.insert(nodeAssignments).values({
      taskId: args.taskId,
      nodeId: args.nodeId,
      kind: args.kind,
      userId: args.newUserId,
      assignedBy: args.actorId,
      assignedAt: args.now,
    })
  }
  // Mirror to task_collaborators so visibility queries pick the new user up.
  const role = args.kind === 'reviewer' ? 'reviewer' : 'clarify_target'
  await db
    .insert(taskCollaborators)
    .values({
      taskId: args.taskId,
      userId: args.newUserId,
      role,
      addedBy: args.actorId,
      addedAt: args.now,
    })
    .onConflictDoNothing()
}
