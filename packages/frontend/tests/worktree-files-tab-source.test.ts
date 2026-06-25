// RFC-065 — source-level guard.
//
// Pins the wiring contract at the file level so a future refactor that
// silently drops the pane / mis-orders the tab list / replaces the panel
// with a placeholder shows up as a red test instead of a UI regression.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'vitest'

const ROOT = resolve(__dirname, '..')

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8')
}

describe('RFC-065 source-level guard', () => {
  test('TAB_ORDER includes worktree-files between outputs and worktree-diff', () => {
    const tabs = read('src/lib/task-detail-tabs.ts')
    const outIdx = tabs.indexOf("'outputs'")
    const filesIdx = tabs.indexOf("'worktree-files'")
    const diffIdx = tabs.indexOf("'worktree-diff'")
    expect(outIdx).toBeGreaterThan(-1)
    expect(filesIdx).toBeGreaterThan(outIdx)
    expect(diffIdx).toBeGreaterThan(filesIdx)
  })

  test('tasks.detail.tsx renders a pane bound to the worktree-files tab', () => {
    const tsx = read('src/routes/tasks.detail.tsx')
    // The hidden-toggle approach is the convention for task-detail panes;
    // the test pins both the literal tab id and the panel import so a
    // refactor that silently removes either fails here.
    expect(tsx).toContain("tab !== 'worktree-files'")
    expect(tsx).toContain('WorktreeFilesPanel')
    expect(tsx).toContain("from '@/components/WorktreeFilesPanel'")
  })

  test('WorktreeFilesPanel wires both worktree endpoints via the shared api module', () => {
    const panel = read('src/components/WorktreeFilesPanel.tsx')
    const apiMod = read('src/api/worktreeFiles.ts')
    expect(panel).toContain('useQuery')
    // RFC-105: the tree + file fetch (and their schema.parse) moved to
    // `@/api/worktreeFiles` so the Markdown preview route shares the exact
    // fetch + query key. The panel now imports the shared fetchers...
    expect(panel).toContain("from '@/api/worktreeFiles'")
    expect(panel).toContain('fetchWorktreeTree')
    expect(panel).toContain('fetchWorktreeFile')
    // ...and the single-sourced module keeps validating server payloads via the
    // shared schemas; if these go away the runtime safety net is gone.
    expect(apiMod).toContain('worktree-tree')
    expect(apiMod).toContain('worktree-file')
    expect(apiMod).toContain('worktreeTreeResponseSchema')
    expect(apiMod).toContain('worktreeFileResponseSchema')
  })
})
