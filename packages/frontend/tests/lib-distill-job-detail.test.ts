// RFC-043 T5 — pure-function tests for the detail-page helpers.

import { describe, expect, test } from 'vitest'
import type {
  MemoryDistillSessionAttempt,
  MemoryDistillSourceEventEntry,
} from '@agent-workflow/shared'
import {
  formatExitCode,
  groupSourceEventsByKind,
  selectAttempts,
  shouldShowFailureDiagnostics,
  truncateStderr,
} from '../src/lib/distill-job-detail'

function mkEvent(
  kind: MemoryDistillSourceEventEntry['kind'],
  id: string,
): MemoryDistillSourceEventEntry {
  return {
    kind,
    id,
    summary: '',
    deepLink: '/',
    deletedOrMissing: false,
    taskId: null,
  }
}

function mkAttempt(idx: number): MemoryDistillSessionAttempt {
  return {
    attemptIndex: idx,
    rootSessionId: null,
    startedAt: null,
    finishedAt: null,
    captureFailed: false,
    tree: null,
  }
}

describe('distill-job-detail helpers', () => {
  test('groupSourceEventsByKind preserves insertion order per kind', () => {
    const groups = groupSourceEventsByKind([
      mkEvent('feedback', 'f1'),
      mkEvent('clarify', 'c1'),
      mkEvent('feedback', 'f2'),
      mkEvent('review', 'r1'),
      mkEvent('clarify', 'c2'),
    ])
    expect(groups.feedback.map((e) => e.id)).toEqual(['f1', 'f2'])
    expect(groups.clarify.map((e) => e.id)).toEqual(['c1', 'c2'])
    expect(groups.review.map((e) => e.id)).toEqual(['r1'])
  })

  test('groupSourceEventsByKind handles empty input', () => {
    const g = groupSourceEventsByKind([])
    expect(g.feedback).toEqual([])
    expect(g.clarify).toEqual([])
    expect(g.review).toEqual([])
  })

  test('selectAttempts sorts by attemptIndex ascending without mutating input', () => {
    const input = [mkAttempt(2), mkAttempt(0), mkAttempt(1)]
    const out = selectAttempts(input)
    expect(out.map((a) => a.attemptIndex)).toEqual([0, 1, 2])
    expect(input.map((a) => a.attemptIndex)).toEqual([2, 0, 1])
  })

  test('formatExitCode renders 0 / non-zero / null distinctly', () => {
    expect(formatExitCode(0)).toBe('0')
    expect(formatExitCode(1)).toBe('1')
    expect(formatExitCode(null)).toBe('—')
    expect(formatExitCode(undefined)).toBe('—')
  })

  test('truncateStderr handles null / empty / long', () => {
    expect(truncateStderr(null)).toBeNull()
    expect(truncateStderr('')).toBeNull()
    expect(truncateStderr('   ')).toBeNull()
    expect(truncateStderr('abc')).toBe('abc')
    const long = 'x'.repeat(5000)
    const out = truncateStderr(long, 100)
    expect(out).toContain('(clipped at 100 chars for display)')
    // Should not exceed 100 + the suffix length.
    expect(out!.length).toBeLessThan(200)
  })

  test('shouldShowFailureDiagnostics flips on the right signals', () => {
    expect(
      shouldShowFailureDiagnostics({ status: 'done', exitCode: 0, lastError: null, attempts: 0 }),
    ).toBe(false)
    expect(
      shouldShowFailureDiagnostics({ status: 'failed', exitCode: 0, lastError: null, attempts: 0 }),
    ).toBe(true)
    expect(
      shouldShowFailureDiagnostics({ status: 'done', exitCode: 1, lastError: null, attempts: 0 }),
    ).toBe(true)
    expect(
      shouldShowFailureDiagnostics({ status: 'done', exitCode: 0, lastError: 'boom', attempts: 0 }),
    ).toBe(true)
    expect(
      shouldShowFailureDiagnostics({ status: 'done', exitCode: 0, lastError: null, attempts: 2 }),
    ).toBe(true)
  })
})
