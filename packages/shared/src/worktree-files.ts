// RFC-065 — task detail page worktree files tab.
//
// Shared zod schemas + types for the two new JSON endpoints
//   GET /api/tasks/:taskId/worktree-tree?path=<rel>
//   GET /api/tasks/:taskId/worktree-file?path=<rel>
// Validates server response on both sides — backend parses before c.json,
// frontend re-parses inside react-query select so a daemon mid-air change
// surfaces as a typed error instead of a silent shape mismatch.

import { z } from 'zod'

export const WORKTREE_FILE_MAX_BYTES = 2 * 1024 * 1024 // 2 MiB
export const WORKTREE_DIR_MAX_ENTRIES = 5000

export const worktreeTreeEntryKindSchema = z.enum(['file', 'directory'])
export type WorktreeTreeEntryKind = z.infer<typeof worktreeTreeEntryKindSchema>

export const worktreeTreeEntrySchema = z.object({
  name: z.string().min(1),
  kind: worktreeTreeEntryKindSchema,
  // bytes for files; null for directories (cheap to skip stat on each child)
  size: z.number().int().nonnegative().nullable(),
})
export type WorktreeTreeEntry = z.infer<typeof worktreeTreeEntrySchema>

export const worktreeTreeResponseSchema = z.object({
  path: z.string(),
  entries: z.array(worktreeTreeEntrySchema),
  truncated: z.boolean(),
})
export type WorktreeTreeResponse = z.infer<typeof worktreeTreeResponseSchema>

export const worktreeFileResponseSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  oversized: z.boolean(),
  content: z.string(),
})
export type WorktreeFileResponse = z.infer<typeof worktreeFileResponseSchema>
