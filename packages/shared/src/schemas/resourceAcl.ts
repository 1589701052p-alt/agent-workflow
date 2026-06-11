// RFC-099 — resource-level ownership ACL schemas.
//
// Five resource types (agent / skill / mcp / plugin / workflow) carry a single
// owner + a per-user grant list + a 'public' switch. Granted users can view
// and use; owner and admins can modify / delete / transfer / manage grants.
// Non-granted non-admin users must not be able to observe the resource at all
// (lists filter, detail 404s).
//
// TaskActorRole is the task-relationship role snapshot recorded on review
// comments / review decisions / clarify submissions (D7/D17): member identity
// wins over the global admin role — 'admin' is only recorded when a
// non-member admin steps in. These snapshots are UI/audit-only and must never
// reach agent prompts.

import { z } from 'zod'
import { UserPublicSchema } from './user'

export const ACL_RESOURCE_TYPES = ['agent', 'skill', 'mcp', 'plugin', 'workflow'] as const

export const AclResourceTypeSchema = z.enum(ACL_RESOURCE_TYPES)
export type AclResourceType = z.infer<typeof AclResourceTypeSchema>

export const ResourceVisibilitySchema = z.enum(['private', 'public'])
export type ResourceVisibility = z.infer<typeof ResourceVisibilitySchema>

export const TaskActorRoleSchema = z.enum(['owner', 'user', 'admin'])
export type TaskActorRole = z.infer<typeof TaskActorRoleSchema>

/** GET /api/{res}/:id/acl response. */
export const ResourceAclSchema = z.object({
  resourceType: AclResourceTypeSchema,
  resourceId: z.string().min(1),
  ownerUserId: z.string().min(1).nullable(),
  /** Public projection of the owner row; null when owner is '__system__' or the user row vanished. */
  owner: UserPublicSchema.nullable(),
  visibility: ResourceVisibilitySchema,
  users: z.array(UserPublicSchema),
  /** True when the current actor may PUT this ACL (owner or admin). */
  canManage: z.boolean(),
})
export type ResourceAcl = z.infer<typeof ResourceAclSchema>

/**
 * PUT /api/{res}/:id/acl body. `userIds` is full-replace semantics. At least
 * one field must be present. Owner transfer keeps the previous owner in the
 * grant list (server-side) so they don't lock themselves out.
 */
export const UpdateResourceAclBodySchema = z
  .object({
    ownerUserId: z.string().min(1).optional(),
    visibility: ResourceVisibilitySchema.optional(),
    userIds: z.array(z.string().min(1)).max(256).optional(),
  })
  .refine(
    (b) => b.ownerUserId !== undefined || b.visibility !== undefined || b.userIds !== undefined,
    { message: 'at least one of ownerUserId / visibility / userIds is required' },
  )
export type UpdateResourceAclBody = z.infer<typeof UpdateResourceAclBodySchema>

/** Per-question attribution entry (clarify collaborative drafts, D8/D14). */
export const ClarifyAnswerAttributionSchema = z.object({
  userId: z.string().min(1),
  role: TaskActorRoleSchema,
  updatedAt: z.number().int().nonnegative(),
})
export type ClarifyAnswerAttribution = z.infer<typeof ClarifyAnswerAttributionSchema>

/** Record<questionId, attribution> — the shape stored in clarify_rounds.answer_attributions_json. */
export const ClarifyAnswerAttributionsSchema = z.record(z.string(), ClarifyAnswerAttributionSchema)
export type ClarifyAnswerAttributions = z.infer<typeof ClarifyAnswerAttributionsSchema>

/** PUT /api/clarify/:nodeRunId/draft body — one question per call (per-question last-write-wins). */
export const ClarifyDraftSaveBodySchema = z.object({
  roundId: z.string().min(1),
  questionId: z.string().min(1),
  value: z.string().max(65536),
})
export type ClarifyDraftSaveBody = z.infer<typeof ClarifyDraftSaveBodySchema>

/** 422 payload listing references the editor may not use (D15 save-time check). */
export const AclMissingRefSchema = z.object({
  type: AclResourceTypeSchema,
  name: z.string().min(1),
})
export type AclMissingRef = z.infer<typeof AclMissingRefSchema>
