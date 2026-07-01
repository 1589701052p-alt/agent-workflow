// RFC-130 — per-node isolated worktree lifecycle (design.md §2/§4/§5).
//
// Each agent node run executes in its OWN isolated git worktree, branched from a
// full snapshot of the canonical worktree taken at dispatch. On success the node's
// delta is 3-way merged back into the canonical worktree under the task write lock.
// This module owns the git mechanics (create / snapshot-final / merge-back / discard);
// the scheduler (services/scheduler.ts) owns the DB column writes + lock ordering
// so it can keep the writeSem critical sections tight (§7).
//
// Multi-repo (RFC-066): every canonical repo gets its OWN iso worktree; snapshot +
// merge-back are per-repo and independent (a conflict in one repo does not touch
// another — design.md §9).

import { join } from 'node:path'
import {
  createIsolatedWorktree,
  deleteIsoRefs,
  isoRefName,
  materializeTree,
  mergeTreeInMemory,
  removeWorktree,
  runGit,
  snapshotFullState,
} from '@/util/git'
import type { Logger } from '@/util/log'

/** One canonical repo + its isolated mirror for a single node run. */
export interface IsoRepo {
  /** Source repo (for `git worktree add/remove` + ref ops). */
  repoPath: string
  /** Canonical worktree — snapshot source + merge-back target. */
  canonWorktreePath: string
  /** The isolated worktree — the node's opencode cwd. */
  isoWorktreePath: string
  /** '' for single-repo; the per-repo sub-dir name for multi-repo. */
  worktreeDirName: string
  baseBranch: string
  /** Full-state snapshot commit the iso branched from (merge base). */
  baseSnapshot: string
  /** Canonical HEAD when the iso was created (iso `reset --mixed` target). */
  taskBaseHead: string
}

export interface IsoHandle {
  taskId: string
  nodeRunId: string
  repos: IsoRepo[]
}

/** A canonical repo as the scheduler knows it (subset of state.repos[]). */
export interface CanonRepo {
  repoPath: string
  worktreePath: string
  worktreeDirName: string
  baseBranch: string
}

/** Absolute iso worktree path — always OUTSIDE any canonical worktree (D14). */
export function isoWorktreePathFor(
  appHome: string,
  taskId: string,
  nodeRunId: string,
  worktreeDirName: string,
): string {
  const root = join(appHome, 'iso', taskId, nodeRunId)
  return worktreeDirName === '' ? root : join(root, worktreeDirName)
}

async function headOf(worktreePath: string): Promise<string> {
  const r = await runGit(worktreePath, ['rev-parse', 'HEAD'])
  return r.stdout.trim()
}
async function treeOf(repoPath: string, commit: string): Promise<string> {
  const r = await runGit(repoPath, ['rev-parse', `${commit}^{tree}`])
  return r.stdout.trim()
}

/**
 * Create the isolated worktree(s) for a node run (all repos). Snapshots each
 * canonical worktree's FULL state (incl. untracked), pins it as the base ref
 * (D26), and checks out an iso worktree with the accumulated changes UNSTAGED
 * (D23/D28). Does NOT touch the DB — the caller persists iso_base_snapshot(s) +
 * iso_worktree_path.
 */
export async function createNodeIso(opts: {
  appHome: string
  taskId: string
  nodeRunId: string
  canonRepos: CanonRepo[]
  submoduleMode?: 'auto' | 'always' | 'never'
  submoduleJobs?: number
  log?: Logger
}): Promise<IsoHandle> {
  const repos: IsoRepo[] = []
  for (const r of opts.canonRepos) {
    const isoWorktreePath = isoWorktreePathFor(
      opts.appHome,
      opts.taskId,
      opts.nodeRunId,
      r.worktreeDirName,
    )
    const taskBaseHead = await headOf(r.worktreePath)
    const baseSnapshot = await snapshotFullState(r.worktreePath, {
      pinRef: isoRefName(opts.taskId, opts.nodeRunId, 'base'),
      log: opts.log,
    })
    await createIsolatedWorktree({
      repoPath: r.repoPath,
      isoPath: isoWorktreePath,
      baseSnapshotCommit: baseSnapshot,
      taskBaseHead,
      ...(opts.submoduleMode !== undefined ? { submoduleMode: opts.submoduleMode } : {}),
      ...(opts.submoduleJobs !== undefined ? { submoduleJobs: opts.submoduleJobs } : {}),
    })
    repos.push({
      repoPath: r.repoPath,
      canonWorktreePath: r.worktreePath,
      isoWorktreePath,
      worktreeDirName: r.worktreeDirName,
      baseBranch: r.baseBranch,
      baseSnapshot,
      taskBaseHead,
    })
  }
  return { taskId: opts.taskId, nodeRunId: opts.nodeRunId, repos }
}

/**
 * Snapshot each iso worktree's FINAL state (the node's product) as a pinned
 * commit (D15/D26 `node` ref). Returns per-repo node_tree shas so the caller can
 * persist iso_node_tree(+_repos_json) BEFORE the merge-back (crash-replay, D15).
 */
export async function snapshotNodeIsoFinal(
  handle: IsoHandle,
  log?: Logger,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const r of handle.repos) {
    out[r.worktreeDirName] = await snapshotFullState(r.isoWorktreePath, {
      pinRef: isoRefName(handle.taskId, handle.nodeRunId, 'node'),
      log,
    })
  }
  return out
}

export interface MergeBackResult {
  clean: boolean
  /** Per-repo conflicted paths (only repos that conflicted appear). */
  conflicts: Array<{ worktreeDirName: string; paths: string[] }>
}

/**
 * Merge each repo's iso final tree back into its canonical worktree (design.md
 * §5). Per repo: snapshot canonical NOW (ours), 3-way merge-tree(base, ours,
 * node_tree). Clean → materialize into canonical (unstaged, HEAD unchanged).
 * Conflict → left for the caller (merge agent / awaiting_human, PR-B); canonical
 * for that repo is NOT touched (D27 — kept clean for sibling merge-backs).
 *
 * `nodeTrees` maps worktreeDirName → node_tree sha (from snapshotNodeIsoFinal, or
 * re-read from the persisted column on a replay).
 */
export async function mergeBackNodeIso(
  handle: IsoHandle,
  nodeTrees: Record<string, string>,
  log?: Logger,
): Promise<MergeBackResult> {
  const conflicts: MergeBackResult['conflicts'] = []
  for (const r of handle.repos) {
    const theirs = nodeTrees[r.worktreeDirName]
    if (theirs === undefined) continue
    const ours = await snapshotFullState(r.canonWorktreePath, { log })
    const merge = await mergeTreeInMemory(r.repoPath, {
      base: r.baseSnapshot,
      ours,
      theirs,
    })
    if (merge.conflicts.length > 0) {
      conflicts.push({ worktreeDirName: r.worktreeDirName, paths: merge.conflicts })
      continue
    }
    const canonCurrentTree = await treeOf(r.repoPath, ours)
    await materializeTree(r.canonWorktreePath, {
      mergedTree: merge.mergedTree,
      canonCurrentTree,
      taskBaseHead: r.taskBaseHead,
    })
  }
  return { clean: conflicts.length === 0, conflicts }
}

/** Remove all iso worktrees + delete the base/node pin refs for a run (best-effort). */
export async function discardNodeIso(handle: IsoHandle, log?: Logger): Promise<void> {
  for (const r of handle.repos) {
    try {
      await removeWorktree({ repoPath: r.repoPath, worktreePath: r.isoWorktreePath, force: true })
    } catch (err) {
      log?.warn('iso worktree remove failed (leaving for GC)', {
        isoWorktreePath: r.isoWorktreePath,
        error: err instanceof Error ? err.message : String(err),
      })
    }
    await deleteIsoRefs(r.repoPath, handle.taskId, handle.nodeRunId)
  }
}
