// RFC-041: Platform long-term memory schemas.
// See design/RFC-041-platform-long-term-memory/design.md §3.1.

import { z } from 'zod'

export const MemoryScopeSchema = z.enum(['agent', 'workflow', 'repo', 'global'])
export type MemoryScope = z.infer<typeof MemoryScopeSchema>

export const MemoryStatusSchema = z.enum([
  'candidate',
  'approved',
  'archived',
  'superseded',
  'rejected',
])
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>

export const MemorySourceKindSchema = z.enum(['clarify', 'review', 'feedback', 'manual'])
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>

export const DistillActionSchema = z.enum(['new', 'update_of', 'duplicate_of', 'conflict_with'])
export type DistillAction = z.infer<typeof DistillActionSchema>

export const DistillJobStatusSchema = z.enum(['pending', 'running', 'done', 'failed', 'canceled'])
export type DistillJobStatus = z.infer<typeof DistillJobStatusSchema>

const tagsArraySchema = z.array(z.string().min(1).max(40)).max(16)

export const MemorySchema = z
  .object({
    id: z.string().min(1),
    scopeType: MemoryScopeSchema,
    scopeId: z.string().nullable(),
    title: z.string().trim().min(1).max(120),
    bodyMd: z.string().trim().min(1).max(4000),
    tags: tagsArraySchema,
    status: MemoryStatusSchema,
    sourceKind: MemorySourceKindSchema,
    sourceEventId: z.string().nullable(),
    sourceTaskId: z.string().nullable(),
    distillJobId: z.string().nullable(),
    distillAction: DistillActionSchema.nullable(),
    supersedesId: z.string().nullable(),
    supersededById: z.string().nullable(),
    approvedByUserId: z.string().nullable(),
    approvedAt: z.number().int().nullable(),
    createdAt: z.number().int(),
    version: z.number().int().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType === 'global' && v.scopeId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'global scope must have scopeId=null',
        path: ['scopeId'],
      })
    }
    if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-global scope requires scopeId',
        path: ['scopeId'],
      })
    }
  })
export type Memory = z.infer<typeof MemorySchema>

export const MemorySummarySchema = z.object({
  id: z.string(),
  scopeType: MemoryScopeSchema,
  scopeId: z.string().nullable(),
  title: z.string(),
  status: MemoryStatusSchema,
  tags: z.array(z.string()),
  approvedAt: z.number().int().nullable(),
  version: z.number().int(),
  distillAction: DistillActionSchema.nullable(),
})
export type MemorySummary = z.infer<typeof MemorySummarySchema>

// Admin-issued promote action on a candidate row. Discriminated union so
// the supersede target ids only appear in the supersede branch.
export const MemoryCandidatePromoteSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('approve'),
    tagsOverride: z.array(z.string().min(1).max(40)).max(16).optional(),
  }),
  z.object({
    action: z.literal('approve_and_supersede'),
    supersedeIds: z.array(z.string().min(1)).min(1).max(8),
    tagsOverride: z.array(z.string().min(1).max(40)).max(16).optional(),
  }),
  z.object({
    action: z.literal('reject'),
  }),
])
export type MemoryCandidatePromote = z.infer<typeof MemoryCandidatePromoteSchema>

// Admin-issued create memory directly (source_kind='manual'). Used by tests
// and the future "admin writes a memory by hand" UI; the audit trail still
// lands the same row.
export const MemoryCreateRequestSchema = z
  .object({
    scopeType: MemoryScopeSchema,
    scopeId: z.string().nullable(),
    title: z.string().trim().min(1).max(120),
    bodyMd: z.string().trim().min(1).max(4000),
    tags: tagsArraySchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scopeType === 'global' && v.scopeId !== null) {
      ctx.addIssue({
        code: 'custom',
        message: 'global scope must have scopeId=null',
        path: ['scopeId'],
      })
    }
    if (v.scopeType !== 'global' && (v.scopeId === null || v.scopeId === '')) {
      ctx.addIssue({
        code: 'custom',
        message: 'non-global scope requires scopeId',
        path: ['scopeId'],
      })
    }
  })
export type MemoryCreateRequest = z.infer<typeof MemoryCreateRequestSchema>

// Resolved scope set computed at enqueue time and frozen on the job row.
export const ResolvedDistillScopeSchema = z.object({
  agentIds: z.array(z.string()),
  workflowId: z.string().nullable(),
  repoId: z.string().nullable(),
  includeGlobal: z.boolean(),
})
export type ResolvedDistillScope = z.infer<typeof ResolvedDistillScopeSchema>

export const MemoryDistillJobSchema = z.object({
  id: z.string(),
  debounceKey: z.string(),
  sourceKind: z.enum(['clarify', 'review', 'feedback']),
  sourceEventId: z.string(),
  taskId: z.string().nullable(),
  scopeResolved: ResolvedDistillScopeSchema,
  status: DistillJobStatusSchema,
  attempts: z.number().int(),
  nextRunAt: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  finishedAt: z.number().int().nullable(),
})
export type MemoryDistillJob = z.infer<typeof MemoryDistillJobSchema>

export const MemoryListFilterSchema = z.object({
  status: MemoryStatusSchema.optional(),
  scopeType: MemoryScopeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  search: z.string().trim().min(1).max(200).optional(),
  tag: z.string().min(1).max(40).optional(),
})
export type MemoryListFilter = z.infer<typeof MemoryListFilterSchema>
