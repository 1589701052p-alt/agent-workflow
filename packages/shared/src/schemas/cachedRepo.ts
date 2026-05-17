// RFC-024: Cached Git URL repo entries surfaced to UI via /api/cached-repos.

import { z } from 'zod'

export const CachedRepoSchema = z.object({
  id: z.string(),
  /** Original URL as stored — may contain credentials. UI MUST render `urlRedacted` instead. */
  url: z.string(),
  /** Safe-to-display form (credentials masked). */
  urlRedacted: z.string(),
  /** Absolute path on disk, e.g. `~/.agent-workflow/repos/abcd1234-bar`. */
  localPath: z.string(),
  /** Default branch detected at clone time. `null` if HEAD was detached / unborn. */
  defaultBranch: z.string().nullable(),
  /** ISO timestamp of last successful `git fetch` (or clone for fresh rows). */
  lastFetchedAt: z.string(),
  /** ISO timestamp of original clone. */
  createdAt: z.string(),
  /** Count of `tasks` rows whose `repoUrl` matches `url`. Joined at query time. */
  referencingTaskCount: z.number().int().nonnegative(),
})
export type CachedRepo = z.infer<typeof CachedRepoSchema>

export const ListCachedReposResponseSchema = z.object({
  items: z.array(CachedRepoSchema),
})
export type ListCachedReposResponse = z.infer<typeof ListCachedReposResponseSchema>

export const RefreshCachedRepoResponseSchema = z.object({
  item: CachedRepoSchema,
  /** True when `git fetch` came back clean; false when fetch failed but cache still serves. */
  fetchOk: z.boolean(),
  /** Redacted stderr from a failed fetch, if any. */
  fetchError: z.string().nullable(),
})
export type RefreshCachedRepoResponse = z.infer<typeof RefreshCachedRepoResponseSchema>

export const DeleteCachedRepoQuerySchema = z.object({
  force: z
    .union([z.literal('1'), z.literal('true'), z.literal('0'), z.literal('false')])
    .optional(),
})
export type DeleteCachedRepoQuery = z.infer<typeof DeleteCachedRepoQuerySchema>
