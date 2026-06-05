// RFC-083 PR-C — task-scoped structural diff. Mirrors getTaskDiff's task →
// (worktree, baseCommit) resolution + error codes (no-base-commit 409,
// worktree-missing 410) so the structural view degrades exactly like the
// textual diff. Single-repo computes directly; multi-repo merges per-repo
// results (status 'partial' when some repos are unusable).
//
// v1 implements the 'task' scope only. 'node' / 'wrapper' scopes need node_runs
// snapshot pairing (RFC-083 PR-C follow-up / refSelect) — requested via the
// `scope` query param, they return a typed 'structural-scope-unsupported'.

import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { DbClient } from '@/db/client'
import { DomainError, NotFoundError, ValidationError } from '@/util/errors'
import type { StructuralDiff, StructuralScope } from '@agent-workflow/shared'
import { getTask } from '@/services/task'
import { computeFromWorktree } from './gitBackend'
import { mergeStructuralDiffs } from './assemble'

export async function getTaskStructuralDiff(
  db: DbClient,
  taskId: string,
  scope: StructuralScope = 'task',
): Promise<StructuralDiff> {
  if (scope !== 'task') {
    throw new ValidationError(
      'structural-scope-unsupported',
      `structural-diff scope '${scope}' is not yet supported (v1 implements 'task')`,
    )
  }

  const task = await getTask(db, taskId)
  if (task === null) {
    throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  }

  if (task.repoCount === 1) {
    if (task.baseCommit === null) {
      throw new DomainError(
        'task-no-base-commit',
        `task '${taskId}' has no base commit recorded; cannot compute structural diff`,
        409,
      )
    }
    if (!existsSync(task.worktreePath)) {
      throw new DomainError(
        'task-worktree-missing',
        `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
        410,
      )
    }
    return computeFromWorktree({
      taskId,
      scope,
      worktreePath: task.worktreePath,
      fromRef: task.baseCommit,
    })
  }

  // Multi-repo: merge per-repo diffs, labeling files by repo dir.
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot compute structural diff`,
      410,
    )
  }
  const usable = task.repos.filter(
    (r) => r.baseCommit !== null && r.baseCommit !== '' && existsSync(r.worktreePath),
  )
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
  return mergeStructuralDiffs(
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
}
