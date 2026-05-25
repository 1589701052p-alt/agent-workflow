// RFC-066 — locks the TaskRepoSchema shape (one row of `task_repos`).
// Single-repo tasks return a length-1 array; multi-repo tasks return N
// entries sorted by repoIndex asc. The schema must accept both legacy
// single-repo "mirror" rows (empty worktreeDirName) and multi-repo rows
// (non-empty worktreeDirName basename including auto-suffix).

import { describe, expect, test } from 'bun:test'
import { TaskRepoSchema } from '../src/schemas/task'

describe('TaskRepoSchema (RFC-066)', () => {
  test('happy path: single-repo mirror row (empty worktreeDirName)', () => {
    const r = TaskRepoSchema.safeParse({
      repoIndex: 0,
      repoPath: '/Users/dev/proj/agent-workflow',
      repoUrl: null,
      baseBranch: 'main',
      branch: 'agent-workflow/01ABCD',
      baseCommit: 'a1b2c3',
      worktreePath: '/Users/dev/.agent-workflow/worktrees/aabbccdd-agent-workflow/01ABCD',
      worktreeDirName: '',
      hasSubmodules: null,
      submoduleInitOk: null,
      submoduleInitError: null,
    })
    expect(r.success).toBe(true)
  })

  test('happy path: multi-repo entry with auto-suffixed dir name', () => {
    const r = TaskRepoSchema.safeParse({
      repoIndex: 1,
      repoPath: '/Users/dev/proj/utils',
      repoUrl: null,
      baseBranch: 'develop',
      branch: 'agent-workflow/01ABCD',
      baseCommit: 'd4e5f6',
      worktreePath: '/Users/dev/.agent-workflow/worktrees/multi/01ABCD/utils-2',
      worktreeDirName: 'utils-2',
      hasSubmodules: true,
      submoduleInitOk: false,
      submoduleInitError: 'fatal: clone of git@host:foo/bar failed',
    })
    expect(r.success).toBe(true)
  })

  test('reject negative repoIndex', () => {
    const r = TaskRepoSchema.safeParse({
      repoIndex: -1,
      repoPath: '/p',
      repoUrl: null,
      baseBranch: '',
      branch: 'b',
      baseCommit: null,
      worktreePath: '/w',
      worktreeDirName: '',
      hasSubmodules: null,
      submoduleInitOk: null,
      submoduleInitError: null,
    })
    expect(r.success).toBe(false)
  })

  test('reject missing required fields', () => {
    // worktreePath omitted
    const r = TaskRepoSchema.safeParse({
      repoIndex: 0,
      repoPath: '/p',
      repoUrl: null,
      baseBranch: 'main',
      branch: 'b',
      baseCommit: null,
      worktreeDirName: '',
      hasSubmodules: null,
      submoduleInitOk: null,
      submoduleInitError: null,
    })
    expect(r.success).toBe(false)
  })
})
