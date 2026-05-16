// Skill schemas — fs is source of truth; DB holds index only.
// Mirrors design/proposal.md §3.2 and design/design.md §3 (skills table).

import { z } from 'zod'

export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

export const SkillNameSchema = z
  .string()
  .min(1, 'name is required')
  .max(128, 'name too long')
  .regex(SKILL_NAME_RE, 'name must start with [a-z0-9] and contain only [a-z0-9_-]')

export const SkillSourceKindSchema = z.enum(['managed', 'external'])
export type SkillSourceKind = z.infer<typeof SkillSourceKindSchema>

/** Skill row response. `managedPath` set iff `managed`, `externalPath` set iff `external`. */
export const SkillSchema = z.object({
  id: z.string(),
  name: SkillNameSchema,
  description: z.string(),
  sourceKind: SkillSourceKindSchema,
  managedPath: z.string().optional(),
  externalPath: z.string().optional(),
  /**
   * RFC-017: when this skill was discovered by reconciling a registered
   * `skill_sources` parent directory, the source row's id is carried here.
   * Hand-imported managed/external skills leave this unset.
   */
  sourceId: z.string().optional(),
  schemaVersion: z.number().int(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type Skill = z.infer<typeof SkillSchema>

/** POST /api/skills — create a managed skill. Writes SKILL.md to disk. */
export const CreateManagedSkillSchema = z.object({
  name: SkillNameSchema,
  description: z.string().default(''),
  bodyMd: z.string().default(''),
  frontmatterExtra: z.record(z.string(), z.unknown()).default({}),
})
export type CreateManagedSkill = z.infer<typeof CreateManagedSkillSchema>

/** POST /api/skills/import-external — register an existing on-disk skill dir. */
export const ImportExternalSkillSchema = z.object({
  name: SkillNameSchema,
  externalPath: z.string().min(1),
  description: z.string().default(''),
})
export type ImportExternalSkill = z.infer<typeof ImportExternalSkillSchema>

/** PUT /api/skills/:name — update DB-only metadata. */
export const UpdateSkillSchema = z.object({
  description: z.string().optional(),
})
export type UpdateSkill = z.infer<typeof UpdateSkillSchema>

/**
 * Parsed SKILL.md content. `frontmatterExtra` holds frontmatter keys other
 * than `name` and `description` so they round-trip through edits.
 */
export const SkillContentSchema = z.object({
  name: SkillNameSchema,
  description: z.string(),
  bodyMd: z.string(),
  frontmatterExtra: z.record(z.string(), z.unknown()),
})
export type SkillContent = z.infer<typeof SkillContentSchema>

/** PUT /api/skills/:name/content — overwrite SKILL.md frontmatter + body. */
export const UpdateSkillContentSchema = z.object({
  description: z.string().optional(),
  bodyMd: z.string().optional(),
  frontmatterExtra: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateSkillContent = z.infer<typeof UpdateSkillContentSchema>

/** One node in the file-tree response. */
export const FileNodeSchema = z.object({
  /** Path relative to the skill's files/ root, with forward slashes. */
  path: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().nonnegative().optional(),
  modifiedAt: z.number().int().optional(),
})
export type FileNode = z.infer<typeof FileNodeSchema>

/** PUT /api/skills/:name/file?path=... body. Text-only in v1. */
export const WriteSkillFileSchema = z.object({
  content: z.string(),
})
export type WriteSkillFile = z.infer<typeof WriteSkillFileSchema>

// ---------------------------------------------------------------------------
// RFC-017: Skill sources (parent directories whose direct children are
// auto-imported as external skills, reconciled lazily on each list request).
// ---------------------------------------------------------------------------

/** Persisted skill_sources row exposed via API. */
export const SkillSourceSchema = z.object({
  id: z.string(),
  /** Absolute, canonicalized (`realpath`) parent directory path. */
  path: z.string(),
  /** Display label; defaults to basename(path) when not supplied. */
  label: z.string(),
  enabled: z.boolean(),
  lastScannedAt: z.number().int().nullable(),
  lastScanError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
})
export type SkillSource = z.infer<typeof SkillSourceSchema>

export const SkillSkipReasonSchema = z.enum([
  'no-skill-md',
  'invalid-name',
  'name-conflict-manual',
  'name-conflict-source',
  'frontmatter-parse-failed',
  'still-referenced',
])
export type SkillSkipReason = z.infer<typeof SkillSkipReasonSchema>

export const SkillSkipReportSchema = z.object({
  childPath: z.string(),
  proposedName: z.string().optional(),
  reason: SkillSkipReasonSchema,
  detail: z.string().optional(),
})
export type SkillSkipReport = z.infer<typeof SkillSkipReportSchema>

export const SkillSourceWithStatsSchema = SkillSourceSchema.extend({
  childCount: z.number().int().nonnegative(),
  skipped: z.array(SkillSkipReportSchema),
})
export type SkillSourceWithStats = z.infer<typeof SkillSourceWithStatsSchema>

/** POST /api/skill-sources body. */
export const CreateSkillSourceSchema = z.object({
  path: z.string().min(1),
  label: z.string().optional(),
})
export type CreateSkillSource = z.infer<typeof CreateSkillSourceSchema>

/** PATCH /api/skill-sources/:id body. */
export const UpdateSkillSourceSchema = z.object({
  label: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
})
export type UpdateSkillSource = z.infer<typeof UpdateSkillSourceSchema>

/** POST /api/skill-sources response shape. */
export const RegisterSkillSourceResponseSchema = z.object({
  source: SkillSourceWithStatsSchema,
  imported: z.array(SkillSchema),
  skipped: z.array(SkillSkipReportSchema),
})
export type RegisterSkillSourceResponse = z.infer<typeof RegisterSkillSourceResponseSchema>

/** POST /api/skill-sources/:id/rescan response shape. */
export const RescanSkillSourceResponseSchema = z.object({
  source: SkillSourceWithStatsSchema,
  imported: z.array(SkillSchema),
  deleted: z.array(z.string()),
  skipped: z.array(SkillSkipReportSchema),
})
export type RescanSkillSourceResponse = z.infer<typeof RescanSkillSourceResponseSchema>
