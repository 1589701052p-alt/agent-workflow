// RFC-083 PR-C — git-backed blob readers for a worktree. Enumerates changed
// files between `fromRef` and the live worktree (tracked + untracked), reads the
// old side via `git show <fromRef>:<path>` and the new side from the worktree on
// disk, and hands them to assembleStructuralDiff.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitChangedFiles, readBlobAtRef } from '@/util/git'
import { assembleStructuralDiff } from './assemble'
import type { StructuralDiff, StructuralScope } from '@agent-workflow/shared'

/** Compute the baseline structural diff between `fromRef` and the current
 *  worktree state. `toRef` is the sentinel 'WORKTREE'. */
export async function computeFromWorktree(opts: {
  taskId: string
  scope: StructuralScope
  nodeRunId?: string
  worktreePath: string
  fromRef: string
}): Promise<StructuralDiff> {
  const changedFiles = await gitChangedFiles(opts.worktreePath, opts.fromRef)
  const readOld = (p: string): Promise<string | null> =>
    readBlobAtRef(opts.worktreePath, opts.fromRef, p)
  const readNew = async (p: string): Promise<string | null> => {
    try {
      return await readFile(join(opts.worktreePath, p), 'utf8')
    } catch {
      return null // deleted in worktree, or unreadable
    }
  }
  return assembleStructuralDiff({
    taskId: opts.taskId,
    scope: opts.scope,
    nodeRunId: opts.nodeRunId,
    fromRef: opts.fromRef,
    toRef: 'WORKTREE',
    changedFiles,
    readOld,
    readNew,
  })
}
