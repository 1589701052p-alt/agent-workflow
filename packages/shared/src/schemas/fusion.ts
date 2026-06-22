// RFC-101 — memory→skill fusion schemas.
// A fusion merges N approved memories into a managed skill via the built-in
// skill-merger opencode agent, gated by mandatory clarify + a before/after diff.

import { z } from 'zod'

export const FusionStatusSchema = z.enum([
  'running', // engine task executing (agent working / clarifying)
  'awaiting_approval', // proposed change ready; merger reviews the diff
  'applying', // approve in progress (atomic skill bump + memory fuse)
  'done',
  'rejected',
  'canceled',
  'failed',
])
export type FusionStatus = z.infer<typeof FusionStatusSchema>

/** One memory the agent chose NOT to incorporate, with its reason. */
export const FusionSkippedSchema = z.object({
  memoryId: z.string(),
  reason: z.string().max(2000).default(''),
})
export type FusionSkipped = z.infer<typeof FusionSkippedSchema>

/** A fusion record (projected for the API). */
export const FusionSchema = z.object({
  id: z.string(),
  skillName: z.string(),
  baseSkillVersion: z.number().int(),
  memoryIds: z.array(z.string()),
  intent: z.string(),
  status: FusionStatusSchema,
  iteration: z.number().int().min(1),
  currentTaskId: z.string().nullable(),
  /** current vs proposed unified diff (set in awaiting_approval). */
  proposedDiff: z.string().nullable(),
  incorporatedMemoryIds: z.array(z.string()).nullable(),
  skipped: z.array(FusionSkippedSchema).nullable(),
  changelog: z.string().nullable(),
  appliedSkillVersion: z.number().int().nullable(),
  ownerUserId: z.string(),
  createdAt: z.number().int(),
  decidedByUserId: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
  decisionReason: z.string().nullable(),
  error: z.string().nullable(),
})
export type Fusion = z.infer<typeof FusionSchema>

/** POST /api/fusions — launch a fusion. */
export const LaunchFusionSchema = z.object({
  skillName: z.string().min(1),
  memoryIds: z.array(z.string().min(1)).min(1).max(32),
  intent: z.string().max(4000).default(''),
  /** Optional per-run model override for the skill-merger agent. */
  model: z.string().min(1).optional(),
  /** RFC-099 task membership — extra collaborators who may answer clarify / approve. */
  collaboratorUserIds: z.array(z.string().min(1)).optional(),
})
export type LaunchFusion = z.infer<typeof LaunchFusionSchema>

/** POST /api/fusions/:id/reject — request changes + re-run. */
export const RejectFusionSchema = z.object({
  feedback: z.string().min(1).max(4000),
})
export type RejectFusion = z.infer<typeof RejectFusionSchema>

/**
 * The manifest the skill-merger agent writes to `__fusion__/result.json` in
 * its worktree, declaring which selected memories it incorporated vs skipped.
 * The framework validates incorporated ⊆ selected and ∩ skipped = ∅.
 */
export const FusionResultManifestSchema = z.object({
  incorporatedMemoryIds: z.array(z.string()).default([]),
  skipped: z.array(FusionSkippedSchema).default([]),
  changelog: z.string().default(''),
})
export type FusionResultManifest = z.infer<typeof FusionResultManifestSchema>
