// RFC-035 PR1 — TaskStatus → StatusChipKind mapping is the contract that
// keeps /tasks list, /tasks/$id header, and the homepage running/recently
// done sections visually aligned. Tests live here so any change to the map
// requires intentional acknowledgement.

import { describe, expect, test } from 'vitest'
import { TASK_STATUS } from '@agent-workflow/shared'
import { TASK_STATUS_KIND, taskStatusToKind } from '../src/lib/task-status'

describe('TASK_STATUS_KIND', () => {
  test('covers every TaskStatus value from the shared schema', () => {
    for (const s of TASK_STATUS) {
      expect(TASK_STATUS_KIND[s], `status ${s}`).toBeDefined()
    }
  })

  test('terminal-success "done" → success', () => {
    expect(taskStatusToKind('done')).toBe('success')
  })

  test('terminal-failure "failed" → danger', () => {
    expect(taskStatusToKind('failed')).toBe('danger')
  })

  test('in-progress "running" → info', () => {
    expect(taskStatusToKind('running')).toBe('info')
  })

  test('all three awaiting / interrupted states → warn', () => {
    expect(taskStatusToKind('awaiting_review')).toBe('warn')
    expect(taskStatusToKind('awaiting_human')).toBe('warn')
    expect(taskStatusToKind('interrupted')).toBe('warn')
  })

  test('pending / canceled → neutral', () => {
    expect(taskStatusToKind('pending')).toBe('neutral')
    expect(taskStatusToKind('canceled')).toBe('neutral')
  })
})
