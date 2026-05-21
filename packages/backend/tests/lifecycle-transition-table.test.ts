// RFC-053 PR-B P-1 — direct test of nextNodeRunStatus() transition table.
//
// PR-A's lifecycle-transitions-current.test.ts locks behavior via service
// entry points. This file locks the table itself: every (status, event)
// pair gets one assertion (legal → expected `to`, illegal → throws).

import { describe, expect, test } from 'bun:test'
import {
  IllegalNodeRunTransition,
  NODE_RUN_STATUS,
  type NodeRunStatus,
  type NodeRunTransitionEvent,
  TERMINAL_NODE_RUN_STATUSES,
  allowedFromStatusesForEvent,
  isTerminalNodeRunStatus,
  nextNodeRunStatus,
} from '@agent-workflow/shared'

// Table of all expected legal (status, event) → status transitions.
// Anything not listed here MUST throw IllegalNodeRunTransition.
const LEGAL: Array<[NodeRunStatus, NodeRunTransitionEvent['kind'], NodeRunStatus]> = [
  ['pending', 'mark-running', 'running'],
  ['running', 'mark-done', 'done'],
  ['pending', 'mark-failed', 'failed'],
  ['running', 'mark-failed', 'failed'],
  ['awaiting_review', 'mark-failed', 'failed'],
  ['awaiting_human', 'mark-failed', 'failed'],
  // mark-canceled accepts any non-terminal
  ['pending', 'mark-canceled', 'canceled'],
  ['running', 'mark-canceled', 'canceled'],
  ['awaiting_review', 'mark-canceled', 'canceled'],
  ['awaiting_human', 'mark-canceled', 'canceled'],
  // mark-interrupted accepts any non-terminal
  ['pending', 'mark-interrupted', 'interrupted'],
  ['running', 'mark-interrupted', 'interrupted'],
  ['awaiting_review', 'mark-interrupted', 'interrupted'],
  ['awaiting_human', 'mark-interrupted', 'interrupted'],
  // review flow
  ['pending', 'park-review', 'awaiting_review'],
  ['running', 'park-review', 'awaiting_review'],
  ['awaiting_review', 'approve-review', 'done'],
  ['awaiting_review', 'iterate-review', 'pending'],
  ['awaiting_review', 'reject-review', 'pending'],
  // clarify
  ['pending', 'park-human', 'awaiting_human'],
  ['running', 'park-human', 'awaiting_human'],
  ['awaiting_human', 'resume-clarify', 'done'],
  // supersede
  ['pending', 'cancel-by-supersede', 'canceled'],
  ['running', 'cancel-by-supersede', 'canceled'],
  ['awaiting_review', 'cancel-by-supersede', 'canceled'],
  ['awaiting_human', 'cancel-by-supersede', 'canceled'],
  // skip / exhaust
  ['pending', 'mark-skipped', 'skipped'],
  ['running', 'mark-exhausted', 'exhausted'],
]

function makeEvent(kind: NodeRunTransitionEvent['kind']): NodeRunTransitionEvent {
  switch (kind) {
    case 'mark-failed':
    case 'mark-canceled':
    case 'cancel-by-supersede':
      return { kind, reason: 't' } as NodeRunTransitionEvent
    case 'mark-skipped':
      return { kind, reason: 't' } as NodeRunTransitionEvent
    default:
      return { kind } as NodeRunTransitionEvent
  }
}

describe('RFC-053 PR-B — nextNodeRunStatus() transition table', () => {
  test('every cell in LEGAL transitions to the expected status', () => {
    for (const [from, kind, expected] of LEGAL) {
      const got = nextNodeRunStatus(from, makeEvent(kind))
      expect({ from, kind, got }).toEqual({ from, kind, got: expected })
    }
  })

  test('terminal statuses throw on ANY event', () => {
    const EVENTS: NodeRunTransitionEvent['kind'][] = [
      'mark-running',
      'mark-done',
      'mark-failed',
      'mark-canceled',
      'mark-interrupted',
      'park-review',
      'approve-review',
      'iterate-review',
      'reject-review',
      'park-human',
      'resume-clarify',
      'cancel-by-supersede',
      'mark-skipped',
      'mark-exhausted',
    ]
    for (const terminal of TERMINAL_NODE_RUN_STATUSES) {
      for (const kind of EVENTS) {
        let threw = false
        try {
          nextNodeRunStatus(terminal, makeEvent(kind))
        } catch (err) {
          threw = err instanceof IllegalNodeRunTransition
        }
        expect({ terminal, kind, threw }).toEqual({ terminal, kind, threw: true })
      }
    }
  })

  test('illegal cells (not in LEGAL and not terminal-source) throw IllegalNodeRunTransition', () => {
    const legalSet = new Set(LEGAL.map(([from, kind]) => `${from}::${kind}`))
    const EVENTS: NodeRunTransitionEvent['kind'][] = [
      'mark-running',
      'mark-done',
      'mark-failed',
      'mark-canceled',
      'mark-interrupted',
      'park-review',
      'approve-review',
      'iterate-review',
      'reject-review',
      'park-human',
      'resume-clarify',
      'cancel-by-supersede',
      'mark-skipped',
      'mark-exhausted',
    ]
    for (const from of NODE_RUN_STATUS) {
      if (isTerminalNodeRunStatus(from)) continue // covered by the terminal test
      for (const kind of EVENTS) {
        if (legalSet.has(`${from}::${kind}`)) continue
        let threw = false
        try {
          nextNodeRunStatus(from, makeEvent(kind))
        } catch (err) {
          threw = err instanceof IllegalNodeRunTransition
        }
        expect({ from, kind, threw }).toEqual({ from, kind, threw: true })
      }
    }
  })

  test('terminal set matches expected ground truth', () => {
    const got: NodeRunStatus[] = [...TERMINAL_NODE_RUN_STATUSES]
    const expected: NodeRunStatus[] = [
      'canceled',
      'done',
      'exhausted',
      'failed',
      'interrupted',
      'skipped',
    ]
    expect(got.sort()).toEqual(expected.sort())
  })

  test('allowedFromStatusesForEvent returns expected sets', () => {
    expect([...allowedFromStatusesForEvent({ kind: 'mark-running' })]).toEqual(['pending'])
    expect([...allowedFromStatusesForEvent({ kind: 'approve-review' })]).toEqual([
      'awaiting_review',
    ])
    const cancelable: NodeRunStatus[] = ['pending', 'running', 'awaiting_review', 'awaiting_human']
    expect([...allowedFromStatusesForEvent({ kind: 'mark-canceled' })].sort()).toEqual(
      cancelable.sort(),
    )
  })
})
