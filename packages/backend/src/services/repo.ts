// Recent-repos cache + on-demand git introspection for the launcher dropdowns.

import type { RecentRepo, RepoFilesResponse, RepoRefsResponse } from '@agent-workflow/shared'
import { desc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { recentRepos } from '@/db/schema'
import {
  currentBranch,
  defaultBranch,
  listBranches,
  listFiles,
  listTags,
  recentCommits,
  requireGitRepo,
  runGit,
} from '@/util/git'
import { createLogger } from '@/util/log'

const log = createLogger('repo')

// --- recent_repos table ---

export async function listRecentRepos(db: DbClient, limit = 20): Promise<RecentRepo[]> {
  const rows = await db
    .select()
    .from(recentRepos)
    .orderBy(desc(recentRepos.lastUsedAt))
    .limit(limit)
  return rows.map((r) => {
    const out: RecentRepo = { path: r.path, lastUsedAt: r.lastUsedAt }
    if (r.defaultBranch !== null) out.defaultBranch = r.defaultBranch
    return out
  })
}

/**
 * Insert or refresh a recent-repo entry. Also probes default branch so the
 * frontend doesn't have to round-trip for that on next launch.
 */
export async function upsertRecentRepo(db: DbClient, path: string): Promise<RecentRepo> {
  await requireGitRepo(path)
  const branch = await defaultBranch(path)
  const now = Date.now()

  const existing = await db.select().from(recentRepos).where(eq(recentRepos.path, path)).limit(1)
  if (existing.length > 0) {
    await db
      .update(recentRepos)
      .set({ lastUsedAt: now, defaultBranch: branch })
      .where(eq(recentRepos.path, path))
  } else {
    await db.insert(recentRepos).values({ path, lastUsedAt: now, defaultBranch: branch })
  }

  const result: RecentRepo = { path, lastUsedAt: now }
  if (branch !== null) result.defaultBranch = branch
  return result
}

// --- read-only views over a repo ---

export async function getRepoRefs(repoPath: string, commitCount = 50): Promise<RepoRefsResponse> {
  await requireGitRepo(repoPath)
  const [branches, tags, commits, current, def] = await Promise.all([
    listBranches(repoPath),
    listTags(repoPath),
    recentCommits(repoPath, commitCount),
    currentBranch(repoPath),
    defaultBranch(repoPath),
  ])
  return {
    branches,
    tags,
    recentCommits: commits,
    currentBranch: current,
    defaultBranch: def,
    hasCommits: commits.length > 0,
  }
}

export async function getRepoFiles(repoPath: string): Promise<RepoFilesResponse> {
  await requireGitRepo(repoPath)
  const files = await listFiles(repoPath)
  return { files }
}

// -----------------------------------------------------------------------------
// RFC-068 — path-mode opt-in fetch
// -----------------------------------------------------------------------------

/**
 * Refresh remote-tracking refs for a user-supplied local repo before a task
 * launches. **Never** runs `pull` / `merge` / `checkout` / `reset` — the user's
 * working tree and HEAD branch are left untouched. The launcher uses this to
 * enable picking `origin/<branch>` as a base ref without forcing the user to
 * run `git fetch` themselves.
 *
 * Non-throwing: returns `{ ok: false, error }` on any failure so the caller
 * can WARN and proceed with the un-refreshed repo (task should still launch).
 */
export async function fetchPathRepoBeforeLaunch(
  repoPath: string,
): Promise<{ ok: boolean; error: string | null }> {
  const r = await runGit(repoPath, ['fetch', '--all', '--prune', '--tags'])
  if (r.exitCode !== 0) {
    const error = r.stderr.trim() || 'git fetch failed'
    log.warn('rfc068/path-fetch-failed', { repoPath, stderr: error })
    return { ok: false, error }
  }
  return { ok: true, error: null }
}
