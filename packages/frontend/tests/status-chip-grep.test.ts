// RFC-035 PR1 — source-level guard. The four indicator components named
// in design.md §3.3 MUST import <StatusChip> from @/components/StatusChip
// (their previous bespoke implementations are gone). If a future PR
// regresses one of them back to a hand-rolled span, this test fires.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

const TARGETS = [
  'components/TaskStatusChip.tsx',
  'components/inventory/StatusBadge.tsx',
  'components/McpProbeStatusChip.tsx',
  'components/home/task-row.tsx',
] as const

describe('RFC-035 status-chip retrofit grep guard', () => {
  for (const rel of TARGETS) {
    test(`${rel} imports and renders <StatusChip>`, () => {
      const body = readFileSync(path.resolve(SRC, rel), 'utf8')
      expect(body.includes('StatusChip')).toBe(true)
      // Renders the component (JSX literal). Both `<StatusChip` and
      // `<StatusChip ` cover the open-tag forms.
      expect(/<StatusChip[\s/>]/.test(body)).toBe(true)
    })
  }

  test('TaskStatusChip + task-row share the lib/task-status.ts map', () => {
    for (const rel of ['components/TaskStatusChip.tsx', 'components/home/task-row.tsx']) {
      const body = readFileSync(path.resolve(SRC, rel), 'utf8')
      expect(body.includes('TASK_STATUS_KIND')).toBe(true)
    }
  })
})
