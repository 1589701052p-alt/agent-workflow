// Locks the awaiting_review jump button in the task-detail NodeRunsTable.
//
// The user-visible bug this guards: when a review node hits
// `awaiting_review`, the task page surfaces the status chip but otherwise
// dead-ends — users had to leave the page and find the global /reviews
// inbox to act on it. This test pins the jump-button affordance so a future
// refactor of the table doesn't quietly drop it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import { shouldShowReviewJump } from '../src/routes/tasks.detail'

const here = (p: string) => resolve(import.meta.dirname, '..', p)

describe('shouldShowReviewJump', () => {
  test('true only for awaiting_review', () => {
    expect(shouldShowReviewJump('awaiting_review')).toBe(true)
  })

  test('false for every other status', () => {
    const others: NodeRun['status'][] = [
      'pending',
      'running',
      'done',
      'failed',
      'canceled',
      'interrupted',
      'exhausted',
      'skipped',
    ]
    for (const s of others) {
      expect(shouldShowReviewJump(s)).toBe(false)
    }
  })
})

describe('tasks.detail.tsx NodeRunsTable wires the Review jump link', () => {
  const src = readFileSync(here('src/routes/tasks.detail.tsx'), 'utf8')

  test('renders the link conditionally on shouldShowReviewJump', () => {
    expect(src).toContain('shouldShowReviewJump(r.status)')
  })

  test('jumps to /reviews/$nodeRunId with the row node-run id', () => {
    expect(src).toContain('to="/reviews/$nodeRunId"')
    expect(src).toContain('params={{ nodeRunId: r.id }}')
  })

  test('uses the tasks.reviewButton translation key', () => {
    expect(src).toContain("t('tasks.reviewButton')")
  })
})
