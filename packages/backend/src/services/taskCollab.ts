// RFC-036 — task collaboration service. PR2 scope: visibility helpers + the
// minimum reads needed for routes/tasks.ts and routes/reviews.ts to gate
// access. PR4 layers in launcher-side writes (recordAssignments,
// recordCollaborators, changeAssignment).

import { and, eq } from 'drizzle-orm'
import type { Actor } from '@/auth/actor'
import { SYSTEM_USER_ID } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import type { tasks } from '@/db/schema'
import { nodeAssignments, taskCollaborators } from '@/db/schema'

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
