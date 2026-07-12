// RFC-066 / RFC-067 / RFC-075 combined-launch interaction lock.
//
// Why this file exists: the three feature refinements live in ONE
// StartTaskSchema.superRefine pass and are orthogonal, but every existing
// schema test exercises them in strict isolation —
//   * start-task-schema-multi-repo.test.ts uses repos[] but never
//     gitUserName / workingBranch / autoCommitPush,
//   * start-task-schema-git-identity.test.ts and
//     start-task-schema-working-branch.test.ts both build on a single-URL
//     base with no repos[] (RFC-165: bases are URL-only).
// Nothing verifies that a multi-repo-only body still reaches the identity-XOR
// (lines 388-394) and working-branch (lines 406-415) refinements lower down.
// The `start-task-source-conflict` early `return` (lines 343-350) only fires
// when BOTH a legacy field AND repos[] are present, so a multi-repo-only body
// must NOT short-circuit those later checks. This file locks that the
// repos[] + git identity + workingBranch + autoCommitPush combination both
// (a) parses when all valid and (b) surfaces both git-identity-incomplete and
// working-branch-invalid (and NOT start-task-source-conflict) when the
// identity is half-filled and the branch is illegal, all in one body.

import { describe, expect, test } from 'bun:test'
import { StartTaskSchema } from '../src/schemas/task'

describe('StartTaskSchema combined multi-repo + identity + working branch', () => {
  // Positive: one body simultaneously carrying repos[{path},{url}], a full
  // valid git identity, a valid working branch, and autoCommitPush:true.
  test('accepts repos[] + git identity + workingBranch + autoCommitPush together', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf',
      name: 't',
      repos: [
        { repoUrl: 'https://h/o/a.git', ref: 'main' },
        { repoUrl: 'git@h:o/r.git', ref: 'dev' },
      ],
      gitUserName: 'Bot',
      gitUserEmail: 'bot@local',
      workingBranch: 'feature/x',
      autoCommitPush: true,
      inputs: {},
    })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.repos?.length).toBe(2)
      expect(r.data.gitUserName).toBe('Bot')
      expect(r.data.gitUserEmail).toBe('bot@local')
      expect(r.data.workingBranch).toBe('feature/x')
      expect(r.data.autoCommitPush).toBe(true)
    }
  })

  // Negative interaction: repos[] present (no legacy fields), half git
  // identity (name only), illegal working branch. The conflict early-return
  // must NOT fire (no legacy field), so both downstream refinements run and
  // both issues coexist.
  test('repos[] + half identity + illegal branch surfaces both issues, no source-conflict', () => {
    const r = StartTaskSchema.safeParse({
      workflowId: 'wf',
      name: 't',
      repos: [{ repoUrl: 'https://h/o/a.git', ref: 'main' }],
      gitUserName: 'Bot',
      workingBranch: 'feature/..bad',
      inputs: {},
    })
    expect(r.success).toBe(false)
    if (!r.success) {
      const identity = r.error.issues.find((i) => i.message === 'git-identity-incomplete')
      expect(identity).toBeDefined()
      expect(identity?.path).toEqual(['gitUserEmail'])

      const branch = r.error.issues.find((i) => i.message === 'working-branch-invalid')
      expect(branch).toBeDefined()
      expect(branch?.path).toEqual(['workingBranch'])

      expect(r.error.issues.some((i) => i.message === 'start-task-source-conflict')).toBe(false)
    }
  })
})
