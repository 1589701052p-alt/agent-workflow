// RFC-036 — task collaboration schemas. RFC-099 (D6) removed the node-level
// assignment mechanism (NodeAssignment*): task membership is the answer-rights
// boundary, and the role tags collapsed to 'owner' | 'collaborator'.

import { z } from 'zod'
import { UserPublicSchema } from './user'

export const TaskCollaboratorRoleSchema = z.enum(['owner', 'collaborator'])

export type TaskCollaboratorRole = z.infer<typeof TaskCollaboratorRoleSchema>

export const TaskCollaboratorSchema = z.object({
  taskId: z.string().min(1),
  userId: z.string().min(1),
  role: TaskCollaboratorRoleSchema,
  addedBy: z.string().min(1),
  addedAt: z.number().int().nonnegative(),
})

export type TaskCollaborator = z.infer<typeof TaskCollaboratorSchema>

/** GET /api/tasks/:id/members response (RFC-099 task members panel). */
export const TaskMembersSchema = z.object({
  taskId: z.string().min(1),
  ownerUserId: z.string().nullable(),
  owner: UserPublicSchema.nullable(),
  users: z.array(UserPublicSchema),
  /** True when the current actor may PUT members (owner or admin). */
  canManage: z.boolean(),
})
export type TaskMembers = z.infer<typeof TaskMembersSchema>

/** PUT /api/tasks/:id/members body — full-replace userIds; both optional but at least one. */
export const UpdateTaskMembersBodySchema = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    userIds: z.array(z.string().min(1)).max(256).optional(),
  })
  .refine((b) => b.ownerUserId !== undefined || b.userIds !== undefined, {
    message: 'at least one of ownerUserId / userIds is required',
  })
export type UpdateTaskMembersBody = z.infer<typeof UpdateTaskMembersBodySchema>
