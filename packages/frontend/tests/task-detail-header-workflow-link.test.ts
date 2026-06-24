// 2026-06-24: surface a jump link to the owning workflow in the task detail
// PAGE HEADER (visible by default, before the tab bar). Previously the only
// workflow link lived inside the "details" tab's meta list
// (tasks.detail.tsx <dl class="task-meta">), which sits behind a NON-default
// tab (the default tab is "workflow-status") — so a user landing on a task
// could not reach its workflow without first switching tabs.
//
// Source-level scan (same pattern as tasks-workflow-name.test.ts +
// task-detail-repo-url.test.ts) because the routed component registers
// against TanStack Router at runtime and is awkward to mount in happy-dom.
// We split the source at the tab bar so the assertions can prove the link
// lives in the always-visible header region, not just "somewhere in the file"
// (the old details-tab link would satisfy a naive whole-file match).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.detail.tsx'),
  'utf-8',
)

// Everything before the tab bar (<nav class="task-detail__tab-bar">) is the
// always-rendered page header; everything after is tab panes, including the
// "details" tab that hosts the original workflow meta row.
const TAB_MARKER = 'task-detail__tab-bar'
const HEADER = SRC.split(TAB_MARKER)[0] ?? ''
const AFTER_HEADER = SRC.slice(SRC.indexOf(TAB_MARKER))

describe('task detail header — workflow jump link', () => {
  test('the tab-bar marker exists so the header/panes split is valid', () => {
    expect(SRC).toContain(TAB_MARKER)
    expect(HEADER.length).toBeGreaterThan(0)
  })

  test('header carries a dedicated workflow jump link (not buried in a tab)', () => {
    expect(HEADER).toContain('task-detail__workflow')
    expect(HEADER).toContain('data-testid="task-detail-header-workflow-link"')
  })

  test('header link targets /workflows/$id with the task workflowId', () => {
    const block = HEADER.slice(HEADER.indexOf('task-detail__workflow'))
    expect(block).toMatch(/to="\/workflows\/\$id"/)
    expect(block).toMatch(/params=\{\{ id: tk\.workflowId \}\}/)
  })

  test('header link shows the workflow name with a workflowId fallback', () => {
    const block = HEADER.slice(HEADER.indexOf('task-detail__workflow'))
    expect(block).toMatch(/tk\.workflowName \?\? tk\.workflowId/)
  })

  test('header link reuses the shared data-table__link style (no bespoke chrome)', () => {
    const block = HEADER.slice(HEADER.indexOf('task-detail__workflow'))
    expect(block).toMatch(/className="data-table__link"/)
  })

  test('the original details-tab workflow meta row is preserved', () => {
    // The richer meta row (with parenthesised ULID) must stay in the details
    // tab — this change ADDS a header shortcut, it does not move the canonical
    // metadata.
    expect(AFTER_HEADER).toContain("t('tasks.metaWorkflow')")
    expect(AFTER_HEADER).toMatch(/to="\/workflows\/\$id"/)
  })
})
