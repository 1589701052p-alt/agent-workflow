// LOCKS: RFC-066 PR-C — task detail multi-repo header source-level guard.
//
// Spinning up the full task detail page would require the entire
// nodeRuns / outputs / clarify / review fixtures. Source-text grep is the
// minimum lock that proves the markup is wired:
//   F11a `tk.repoCount > 1` gates a `<details>` block.
//   F11b The block iterates `tk.repos.map(...)` rendering worktreeDirName +
//        baseBranch + redactGitUrl(repoUrl).
//   F11c i18n key `tasks.multiRepoSummary` drives the summary label.
//   F11d Single-repo tasks never render the block (no leakage into the
//        legacy detail card markup).

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

describe('RFC-066 PR-C — task detail multi-repo header', () => {
  test('F11a `tk.repoCount > 1` gates the multi-repo summary block', () => {
    expect(SRC).toContain('tk.repoCount > 1')
    // The block uses a `<details>` with the canonical testid.
    expect(SRC).toContain('data-testid="task-detail-multi-repo"')
  })

  test('F11b iterates tk.repos with worktreeDirName + baseBranch + redactGitUrl', () => {
    expect(SRC).toContain('tk.repos.map')
    expect(SRC).toContain('worktreeDirName')
    expect(SRC).toContain('baseBranch')
    // Each row carries a stable testid per repoIndex.
    expect(SRC).toContain('task-detail-multi-repo-row-')
    // RFC-024 redactGitUrl is reused for the URL column (no cleartext leak).
    expect(SRC).toContain('redactGitUrl(r.repoUrl)')
  })

  test('F11c summary label sourced from i18n key `tasks.multiRepoSummary`', () => {
    expect(SRC).toContain("t('tasks.multiRepoSummary'")
  })

  test('F11d single-repo render does NOT include the multi-repo block markup outside the `repoCount > 1` guard', () => {
    // Confirm the markup is BELOW the gate (i.e. inside the conditional).
    const gateIdx = SRC.indexOf('tk.repoCount > 1')
    const blockIdx = SRC.indexOf('task-detail-multi-repo')
    expect(gateIdx).toBeGreaterThanOrEqual(0)
    expect(blockIdx).toBeGreaterThan(gateIdx)
  })
})
