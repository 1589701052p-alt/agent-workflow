// RFC-105 — shared worktree-tree / worktree-file fetchers.
//
// Extracted from WorktreeFilesPanel (RFC-065) so the new Markdown preview route
// (`/tasks/$id/preview`, file mode) reuses the SAME fetch + the SAME TanStack
// query key `['worktreeFile', taskId, path]`. A preview opened for a file the
// user just viewed in the working-dir tab therefore renders from cache (a
// `staleTime: 0` background revalidate still fires — desirable for live tasks).
// Single-sourcing the fetch keeps the schema.parse validation in one place.

import { api } from '@/api/client'
import {
  worktreeFileResponseSchema,
  worktreeTreeResponseSchema,
  type WorktreeFileResponse,
  type WorktreeTreeResponse,
} from '@agent-workflow/shared'

export async function fetchWorktreeTree(
  taskId: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorktreeTreeResponse> {
  const raw = await api.get<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/worktree-tree`,
    { path },
    signal,
  )
  return worktreeTreeResponseSchema.parse(raw)
}

export async function fetchWorktreeFile(
  taskId: string,
  path: string,
  signal?: AbortSignal,
): Promise<WorktreeFileResponse> {
  const raw = await api.get<unknown>(
    `/api/tasks/${encodeURIComponent(taskId)}/worktree-file`,
    { path },
    signal,
  )
  return worktreeFileResponseSchema.parse(raw)
}
