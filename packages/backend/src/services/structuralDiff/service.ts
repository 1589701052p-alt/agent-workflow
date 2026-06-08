// RFC-083 — structural diff service. Mirrors getTaskDiff's task →
// (worktree, baseCommit) resolution + error codes (no-base-commit 409,
// worktree-missing 410) so the structural view degrades exactly like the
// textual diff. Single-repo computes directly; multi-repo merges per-repo
// results (status 'partial' when some repos are unusable).
//
// Scopes: 'task' (base_commit → worktree), 'node' (a write node's pre_snapshot
// → the next write node's pre_snapshot / worktree, single-repo). 'wrapper' is
// not yet wired and returns a typed 'structural-scope-unsupported'.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { asc, eq } from 'drizzle-orm'
import type { DbClient } from '@/db/client'
import { nodeRuns } from '@/db/schema'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import { isGitWorkTree } from '@/util/git'
import { computeSummary, type StructuralDiff, type StructuralScope } from '@agent-workflow/shared'
import { getTask } from '@/services/task'
import { WrapperProgressSchema } from '@/services/wrapperProgress'
import { computeFromWorktree, computeBetweenRefs } from './gitBackend'
import { mergeStructuralDiffs } from './assemble'
import { resolveNodeScope } from './refSelect'
import { readStoredDiff, writeStoredDiff, isTerminalTaskStatus } from './store'
import {
  computeDeepStructuralDiff,
  DeepUnavailableError,
  type ResolvedDeepConfig,
} from './deep/service'

/** Deep-mode request: try the external SCIP indexer, fall back to baseline. */
export interface DeepOpts {
  mode: 'baseline' | 'deep'
  deepCfg?: ResolvedDeepConfig
}

/** Compute the baseline, then (if deep requested) try to upgrade its impact to
 *  precise SCIP-resolved callers — falling back to baseline on ANY failure. */
async function withDeep(
  deepOpts: DeepOpts | undefined,
  worktreePath: string,
  computeBaseline: () => Promise<StructuralDiff>,
): Promise<StructuralDiff> {
  const baseline = await computeBaseline()
  if (deepOpts?.mode !== 'deep') return baseline
  try {
    return await computeDeepStructuralDiff({
      baseline,
      worktreePath,
      deps: { deepCfg: deepOpts.deepCfg },
    })
  } catch (err) {
    const reason = err instanceof DeepUnavailableError ? err.reason : 'build-failed'
    return { ...baseline, engine: 'baseline', degradedReason: reason }
  }
}

export async function getTaskStructuralDiff(
  db: DbClient,
  taskId: string,
  scope: StructuralScope = 'task',
  nodeRunId?: string,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  if (scope === 'node') {
    return getNodeStructuralDiff(db, task, nodeRunId, deepOpts)
  }
  if (scope === 'wrapper') {
    return getWrapperStructuralDiff(db, task, nodeRunId, deepOpts)
  }

  if (task.repoCount === 1) {
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute structural diff`,
        409,
      )
    }
    if (!(await isGitWorkTree(task.worktreePath))) {
      // Worktree GC'd OR no longer a git repo (source repo moved/deleted) —
      // serve the eager-persisted artifact if we have one, else a clean 410
      // (RFC-089 P1: `existsSync` alone let a broken worktree reach `git diff`
      // and 500; `isGitWorkTree` collapses it to the same 410 as the textual
      // diff tab).
      const stored = await readStoredDiff(taskId, 'task')
      if (stored !== null) return stored
      throw new DomainError(
        'task-worktree-missing',
        `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
        410,
      )
    }
    const baseCommit = task.baseCommit
    const diff = await withDeep(deepOpts, task.worktreePath, () =>
      computeFromWorktree({ taskId, scope, worktreePath: task.worktreePath, fromRef: baseCommit }),
    )
    // Persist the BASELINE for terminal tasks so the view survives a later
    // worktree GC. Never persist a deep request's result (deep is on-demand).
    if (deepOpts?.mode !== 'deep' && isTerminalTaskStatus(task.status)) void writeStoredDiff(diff)
    return diff
  }

  // Multi-repo: merge per-repo diffs, labeling files by repo dir.
  if (!existsSync(task.worktreePath)) {
    const stored = await readStoredDiff(taskId, 'task')
    if (stored !== null) return stored
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
      410,
    )
  }
  const candidates = task.repos.filter(
    (r) => r.baseCommit !== null && r.baseCommit !== '' && existsSync(r.worktreePath),
  )
  // RFC-089 P1: a repo worktree dir can outlive its source repo, so existsSync
  // isn't enough — drop non-git ones as bad shards (mirrors getTaskDiff).
  const valid = await Promise.all(candidates.map((r) => isGitWorkTree(r.worktreePath)))
  const usable = candidates.filter((_, i) => valid[i])
  if (usable.length === 0) {
    throw new DomainError(
      'task-no-base-commit',
      `task '${taskId}' has no repo with a recorded base commit; cannot compute structural diff`,
      409,
    )
  }
  const parts: Array<{ label: string; diff: StructuralDiff }> = []
  for (const repo of usable) {
    const diff = await computeFromWorktree({
      taskId,
      scope,
      worktreePath: repo.worktreePath,
      fromRef: repo.baseCommit as string,
    })
    parts.push({ label: repo.worktreeDirName || basename(repo.repoPath), diff })
  }
  const merged = mergeStructuralDiffs(
    {
      scope,
      taskId,
      fromRef: 'multi',
      toRef: 'WORKTREE',
      engine: 'baseline',
      status: usable.length === task.repos.length ? 'ok' : 'partial',
    },
    parts,
  )
  if (isTerminalTaskStatus(task.status)) void writeStoredDiff(merged)
  return merged
}

type ResolvedTask = NonNullable<Awaited<ReturnType<typeof getTask>>>

/** Per-node structural diff: what did this specific node run change? */
async function getNodeStructuralDiff(
  db: DbClient,
  task: ResolvedTask,
  nodeRunId: string | undefined,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  if (nodeRunId === undefined || nodeRunId === '') {
    throw new ValidationError(
      'structural-node-run-required',
      `structural-diff scope 'node' requires a 'nodeRunId' query param`,
    )
  }
  if (task.repoCount !== 1) {
    // Multi-repo per-node snapshots live in pre_snapshot_repos_json — deferred.
    throw new ValidationError(
      'structural-node-scope-multi-repo-unsupported',
      `per-node structural diff is single-repo only in v1`,
    )
  }

  const rows = await db
    .select({
      id: nodeRuns.id,
      preSnapshot: nodeRuns.preSnapshot,
      startedAt: nodeRuns.startedAt,
      wrapperProgressJson: nodeRuns.wrapperProgressJson,
    })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, task.id))
    .orderBy(asc(nodeRuns.startedAt), asc(nodeRuns.id))

  // A git-wrapper node selected in the per-node picker → use its recorded
  // baseline (the wrapper's diff is baseline → worktree, not a snapshot pair).
  const target = rows.find((r) => r.id === nodeRunId)
  if (target !== undefined && parseWrapperGitBaseline(target.wrapperProgressJson) !== null) {
    return getWrapperStructuralDiff(db, task, nodeRunId, deepOpts)
  }

  const res = resolveNodeScope(rows, nodeRunId)
  if (res.kind === 'not-found') {
    throw new NotFoundError(
      'node-run-not-found',
      `node run '${nodeRunId}' not found in task '${task.id}'`,
    )
  }
  if (res.kind === 'readonly') {
    // Readonly / non-write node correctly contributes nothing.
    return emptyNodeDiff(task.id, nodeRunId, 'readonly-node-no-snapshot')
  }
  if (!(await isGitWorkTree(task.worktreePath))) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
      410,
    )
  }
  const worktreePath = task.worktreePath
  const resolution = res
  try {
    return await withDeep(deepOpts, worktreePath, () =>
      resolution.kind === 'between'
        ? computeBetweenRefs({
            taskId: task.id,
            scope: 'node',
            nodeRunId,
            worktreePath,
            fromRef: resolution.fromRef,
            toRef: resolution.toRef,
          })
        : computeFromWorktree({
            taskId: task.id,
            scope: 'node',
            nodeRunId,
            worktreePath,
            fromRef: resolution.fromRef,
          }),
    )
  } catch {
    // Snapshot objects pruned by a post-GC `git gc` — surface gracefully.
    return emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned')
  }
}

function emptyNodeDiff(
  taskId: string,
  nodeRunId: string,
  degradedReason: string,
  status: StructuralDiff['status'] = 'ok',
  scope: StructuralScope = 'node',
): StructuralDiff {
  return {
    scope,
    taskId,
    nodeRunId,
    fromRef: '',
    toRef: '',
    engine: 'baseline',
    status,
    degradedReason,
    files: [],
    dependencyChanges: [],
    impact: [],
    classEdges: [],
    summary: computeSummary([], []),
  }
}

/** wrapper-git baseline commit (the HEAD captured before the inner scope), or
 *  null when the node isn't a git wrapper / has no recorded baseline. */
export function parseWrapperGitBaseline(json: string | null): string | null {
  if (json === null || json === '') return null
  try {
    const parsed = WrapperProgressSchema.safeParse(JSON.parse(json))
    if (!parsed.success || parsed.data.kind !== 'git') return null
    const baseline = parsed.data.baseline
    return baseline !== undefined && baseline !== '' ? baseline : null
  } catch {
    return null
  }
}

/** Per-wrapper structural diff: what did a git-wrapper's inner scope change?
 *  fromRef = the wrapper's recorded baseline commit; toRef = the worktree. */
async function getWrapperStructuralDiff(
  db: DbClient,
  task: ResolvedTask,
  nodeRunId: string | undefined,
  deepOpts?: DeepOpts,
): Promise<StructuralDiff> {
  if (nodeRunId === undefined || nodeRunId === '') {
    throw new ValidationError(
      'structural-node-run-required',
      `structural-diff scope 'wrapper' requires a 'nodeRunId' query param`,
    )
  }
  if (task.repoCount !== 1) {
    throw new ValidationError(
      'structural-wrapper-scope-multi-repo-unsupported',
      `per-wrapper structural diff is single-repo only in v1`,
    )
  }
  const row = (
    await db
      .select({ wrapperProgressJson: nodeRuns.wrapperProgressJson })
      .from(nodeRuns)
      .where(eq(nodeRuns.id, nodeRunId))
      .limit(1)
  )[0]
  if (row === undefined) {
    throw new NotFoundError(
      'node-run-not-found',
      `node run '${nodeRunId}' not found in task '${task.id}'`,
    )
  }
  const baseline = parseWrapperGitBaseline(row.wrapperProgressJson)
  if (baseline === null) {
    throw new ValidationError(
      'structural-wrapper-not-git',
      `node run '${nodeRunId}' is not a git-wrapper with a recorded baseline commit`,
    )
  }
  if (!(await isGitWorkTree(task.worktreePath))) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' is unavailable (missing or no longer a git repository); cannot compute structural diff`,
      410,
    )
  }
  const worktreePath = task.worktreePath
  try {
    return await withDeep(deepOpts, worktreePath, () =>
      computeFromWorktree({
        taskId: task.id,
        scope: 'wrapper',
        nodeRunId,
        worktreePath,
        fromRef: baseline,
      }),
    )
  } catch {
    return emptyNodeDiff(task.id, nodeRunId, 'snapshot-pruned', 'pruned', 'wrapper')
  }
}
