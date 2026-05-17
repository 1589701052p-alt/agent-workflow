// RFC-036 — task collaboration + node assignment schemas.

import { z } from 'zod'

export const TaskCollaboratorRoleSchema = z.enum([
  'owner',
  'reviewer',
  'clarify_target',
  'collaborator',
])

export type TaskCollaboratorRole = z.infer<typeof TaskCollaboratorRoleSchema>

export const TaskCollaboratorSchema = z.object({
  taskId: z.string().min(1),
  userId: z.string().min(1),
  role: TaskCollaboratorRoleSchema,
  addedBy: z.string().min(1),
  addedAt: z.number().int().nonnegative(),
})

export type TaskCollaborator = z.infer<typeof TaskCollaboratorSchema>

export const NodeAssignmentKindSchema = z.enum(['reviewer', 'clarify_target'])

export type NodeAssignmentKind = z.infer<typeof NodeAssignmentKindSchema>

export const NodeAssignmentSchema = z.object({
  taskId: z.string().min(1),
  nodeId: z.string().min(1),
  kind: NodeAssignmentKindSchema,
  userId: z.string().min(1),
  assignedBy: z.string().min(1),
  assignedAt: z.number().int().nonnegative(),
})

export type NodeAssignment = z.infer<typeof NodeAssignmentSchema>

/** Payload accepted by POST /api/tasks and PATCH /api/tasks/:id/assignments/:nodeId. */
export const NodeAssignmentInputSchema = z.object({
  nodeId: z.string().min(1),
  kind: NodeAssignmentKindSchema,
  userId: z.string().min(1),
})

export type NodeAssignmentInput = z.infer<typeof NodeAssignmentInputSchema>
