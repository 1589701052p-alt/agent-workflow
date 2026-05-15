// repoLaunchIssue — gates the launcher's Start button on the chosen
// repo's commit state. Locks in the fix for a user-visible footgun:
// `git init -b main` alone leaves `main` unresolvable, so the daemon
// later dies at `git worktree add` with `cannot resolve base ref 'main'`.
// The launcher now refuses the launch up front when `hasCommits: false`.

import { describe, expect, test } from 'vitest'
import { repoLaunchIssue } from '../src/routes/workflows.launch'

describe('repoLaunchIssue', () => {
  test('null refs (still loading) → null (do not block on a stale signal)', () => {
    expect(repoLaunchIssue(null)).toBeNull()
  })

  test('hasCommits=true → null (launchable)', () => {
    expect(repoLaunchIssue({ hasCommits: true })).toBeNull()
  })

  test('hasCommits=false → no-commits (must block; would otherwise hit `cannot resolve base ref` post-submit)', () => {
    expect(repoLaunchIssue({ hasCommits: false })).toBe('no-commits')
  })
})
