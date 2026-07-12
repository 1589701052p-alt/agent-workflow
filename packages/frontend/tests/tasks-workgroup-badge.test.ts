// RFC-164 PR-4 — /tasks list rows flag workgroup tasks with a StatusChip
// badge next to the workflow cell (their workflowId points at the builtin
// host workflow, so the workflow name alone would be misleading).
//
// Source-level lock, same idiom as tasks-list-name-column.test.ts — the list
// route renders against live queries, so a full RTL render buys nothing over
// pinning the wiring + the i18n keys.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { enUS } from '../src/i18n/en-US'
import { zhCN } from '../src/i18n/zh-CN'

const SRC = readFileSync(resolve(import.meta.dirname, '..', 'src', 'routes', 'tasks.tsx'), 'utf-8')

describe('routes/tasks.tsx — workgroup badge', () => {
  test('the workflow cell renders a StatusChip gated on row.workgroupId != null', () => {
    // Gate + chip + label, in one contiguous block (the badge must live in
    // the SAME <td> as the workflow link — column count is locked elsewhere).
    const cell = SRC.slice(SRC.indexOf('/workflows/$id'), SRC.indexOf('<TaskStatusChip'))
    expect(cell).toContain('row.workgroupId != null')
    expect(cell).toContain('<StatusChip')
    expect(cell).toContain("t('tasks.workgroupBadge')")
  })

  test('badge testid carries the row id for per-row assertions', () => {
    expect(SRC).toContain('task-workgroup-badge-${row.id}')
  })

  test('both bundles label the badge', () => {
    expect(zhCN.tasks.workgroupBadge).toBe('工作组')
    expect(enUS.tasks.workgroupBadge.length).toBeGreaterThan(0)
  })
})
