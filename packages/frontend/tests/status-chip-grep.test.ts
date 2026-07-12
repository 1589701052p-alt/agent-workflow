// RFC-035 PR1 — source-level guard. The four indicator components named
// in design.md §3.3 MUST import <StatusChip> from @/components/StatusChip
// (their previous bespoke implementations are gone). If a future PR
// regresses one of them back to a hand-rolled span, this test fires.
//
// RFC-150 PR-1 (flag-audit §4.6 W0 补做) extends the guard into a ratchet:
// the 15 remaining hand-rolled `status-chip status-chip--…` spans were folded
// into <StatusChip>, so the raw class-pair literal is now banned across src/
// entirely (only components/StatusChip.tsx itself may compose the chain).

import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(here, '../src')

function listFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(full)
  }
  return out
}

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

  test('RFC-150 ratchet: no bare `status-chip status-chip--` literal anywhere in src/', () => {
    const offenders = listFiles(SRC).filter((f) => {
      // The primitive itself is the one legitimate composer of the chain.
      if (f.endsWith(path.join('components', 'StatusChip.tsx'))) return false
      return readFileSync(f, 'utf8').includes('status-chip status-chip--')
    })
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
