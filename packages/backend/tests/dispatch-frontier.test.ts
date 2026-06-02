// RFC-076 PR-A — trim-B dispatch predicates (isDispatchable / wrapperHasFreshInnerWork).
//
// These lock the much-reviewed (3 adversarial rounds) corrections to the
// original full-B sketch. Pure-function locks in the style of freshness.test.ts.
// If any goes red, re-read design/RFC-076-…/design.md §3 + the round-2/3 reports.

import { describe, expect, test } from 'bun:test'
import type { NodeKind, WorkflowDefinition } from '@agent-workflow/shared'
import type { nodeRuns } from '../src/db/schema'
import {
  isDispatchable,
  wrapperHasFreshInnerWork,
  wrapperInnerDescendants,
} from '../src/services/dispatchFrontier'
import { encodeWrapperProgress } from '../src/services/wrapperProgress'

type Row = typeof nodeRuns.$inferSelect

function run(over: Partial<Row>): Row {
  return {
    id: '01R',
    nodeId: 'n',
    iteration: 0,
    status: 'done',
    consumedUpstreamRunsJson: null,
    wrapperProgressJson: null,
    ...over,
  } as unknown as Row
}
function doneRow(id: string): Row {
  return { id, status: 'done' } as unknown as Row
}
const NO_FRESH = new Map<string, Row>()
// A row whose consumed map is empty is ALWAYS fresh (isNodeRunFresh B1).
const FRESH_DONE = run({ status: 'done', consumedUpstreamRunsJson: null })
// done but stale: consumed an OLD upstream run while the upstream advanced.
const STALE_DONE = run({
  status: 'done',
  consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }),
})
const STALE_FRESHEST = new Map<string, Row>([['up', doneRow('01NEW')]])

// Minimal WorkflowDefinition: only .nodes (id/kind/nodeIds) is read.
function def(nodes: Array<{ id: string; kind: NodeKind; nodeIds?: string[] }>): WorkflowDefinition {
  return { nodes, edges: [] } as unknown as WorkflowDefinition
}

describe('RFC-076 PR-A — isDispatchable (trim-B status gate)', () => {
  const emptyDef = def([{ id: 'n', kind: 'agent-single' }])

  test('never-ran (undefined) → dispatchable', () => {
    expect(isDispatchable(undefined, 'agent-single', NO_FRESH, [], emptyDef)).toBe(true)
  })
  test('pending → dispatchable (out-of-band mint / placeholder)', () => {
    expect(isDispatchable(run({ status: 'pending' }), 'agent-single', NO_FRESH, [], emptyDef)).toBe(
      true,
    )
  })
  test('done ∧ fresh → NOT dispatchable', () => {
    expect(isDispatchable(FRESH_DONE, 'agent-single', NO_FRESH, [], emptyDef)).toBe(false)
  })
  test('done ∧ stale → dispatchable (stale-done re-run)', () => {
    expect(isDispatchable(STALE_DONE, 'agent-single', STALE_FRESHEST, [], emptyDef)).toBe(true)
  })

  // N1 — the critical reversal: failed/interrupted are the resume/retry signal.
  test('failed → dispatchable (resume/retry re-mint signal, N1)', () => {
    expect(isDispatchable(run({ status: 'failed' }), 'agent-single', NO_FRESH, [], emptyDef)).toBe(
      true,
    )
  })
  test('interrupted → dispatchable (daemon-restart resume, N1)', () => {
    expect(
      isDispatchable(run({ status: 'interrupted' }), 'agent-single', NO_FRESH, [], emptyDef),
    ).toBe(true)
  })

  // HIGH-2 — exhausted (loop-max) is a true terminal, NOT dispatchable.
  test('exhausted → NOT dispatchable (loop-max true terminal, HIGH-2)', () => {
    expect(
      isDispatchable(run({ status: 'exhausted' }), 'wrapper-loop', NO_FRESH, [], emptyDef),
    ).toBe(false)
  })
  test('canceled / running → NOT dispatchable', () => {
    expect(
      isDispatchable(run({ status: 'canceled' }), 'agent-single', NO_FRESH, [], emptyDef),
    ).toBe(false)
    expect(isDispatchable(run({ status: 'running' }), 'agent-single', NO_FRESH, [], emptyDef)).toBe(
      false,
    )
  })

  // C2 — a FRESH leaf parked node never re-dispatches (the round-1 busy-loop
  // fix); the `run` helper defaults consumed=null ⇒ always fresh.
  test('FRESH leaf awaiting_human (clarify) → NOT dispatchable (C2)', () => {
    expect(
      isDispatchable(run({ status: 'awaiting_human' }), 'clarify', NO_FRESH, [], emptyDef),
    ).toBe(false)
  })
  test('FRESH leaf awaiting_review (review) → NOT dispatchable (C2)', () => {
    expect(
      isDispatchable(run({ status: 'awaiting_review' }), 'review', NO_FRESH, [], emptyDef),
    ).toBe(false)
  })

  // RFC-076 S8/S11 fix — a STALE parked leaf (consumed an upstream run that has
  // since advanced) MUST re-dispatch, symmetric with stale `done`. Otherwise
  // approving a review built on an obsolete upstream re-reviews on next entry.
  // `dispatchedThisInvocation` (N3, in deriveFrontier) bounds the re-run to once.
  test('STALE leaf awaiting_review → dispatchable (re-park against fresh upstream, S8/S11)', () => {
    const staleParked = run({
      status: 'awaiting_review',
      consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }),
    })
    expect(isDispatchable(staleParked, 'review', STALE_FRESHEST, [], emptyDef)).toBe(true)
  })
  test('STALE leaf awaiting_human → dispatchable (symmetry with stale done)', () => {
    const staleParked = run({
      status: 'awaiting_human',
      consumedUpstreamRunsJson: JSON.stringify({ up: '01OLD' }),
    })
    expect(isDispatchable(staleParked, 'clarify', STALE_FRESHEST, [], emptyDef)).toBe(true)
  })

  // N2 — wrapper awaiting_* is a resume anchor, dispatchable iff inner has fresh work.
  test('wrapper-loop awaiting_human WITH fresh inner pending → dispatchable (N2)', () => {
    const wrapDef = def([
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['inner_agent'] },
      { id: 'inner_agent', kind: 'agent-single' },
    ])
    const wrapperRow = run({
      nodeId: 'lw',
      status: 'awaiting_human',
      iteration: 0,
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [
      wrapperRow,
      run({ id: '01P', nodeId: 'inner_agent', status: 'pending', iteration: 2 }),
    ]
    expect(isDispatchable(wrapperRow, 'wrapper-loop', NO_FRESH, rows, wrapDef)).toBe(true)
  })
  test('wrapper-loop awaiting_human WITHOUT fresh inner → NOT dispatchable (stay parked)', () => {
    const wrapDef = def([
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['inner_agent'] },
      { id: 'inner_agent', kind: 'agent-single' },
    ])
    const wrapperRow = run({
      nodeId: 'lw',
      status: 'awaiting_human',
      iteration: 0,
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    // inner only has a DONE row at iter 2 — no pending → user hasn't answered.
    const rows = [
      wrapperRow,
      run({ id: '01D', nodeId: 'inner_agent', status: 'done', iteration: 2 }),
    ]
    expect(isDispatchable(wrapperRow, 'wrapper-loop', NO_FRESH, rows, wrapDef)).toBe(false)
  })
})

describe('RFC-076 PR-A — wrapperHasFreshInnerWork (HIGH-1 iteration window)', () => {
  const loopDef = def([
    { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a', 'c'] },
    { id: 'a', kind: 'agent-single' },
    { id: 'c', kind: 'clarify' },
  ])

  // HIGH-1 KEY: wrapper row at iteration 0, inner rerun at loop counter 2.
  test('loop: inner pending at progress.iteration (i≥1) while wrapper row at iter 0 → true', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0, // parentIteration
      status: 'awaiting_human',
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 2 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, loopDef)).toBe(true)
  })

  // Iteration window must be precise: a pending at the WRONG iteration doesn't count.
  test('loop: inner pending at iteration 1 but progress.iteration 2 → false (window precise)', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 1 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, loopDef)).toBe(false)
  })

  test('loop: no inner pending anywhere → false', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: encodeWrapperProgress({ kind: 'loop', iteration: 2, phase: 'awaiting' }),
    })
    const rows = [wrapperRow, run({ id: '01D', nodeId: 'a', status: 'done', iteration: 2 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, loopDef)).toBe(false)
  })

  test('loop: malformed/absent progress → fallback iteration 0', () => {
    const wrapperRow = run({
      nodeId: 'lw',
      iteration: 0,
      status: 'awaiting_human',
      wrapperProgressJson: null,
    })
    const atZero = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 0 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, atZero, loopDef)).toBe(true)
    const atTwo = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 2 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, atTwo, loopDef)).toBe(false)
  })

  // git inner shares the wrapper's own iteration.
  test('git: inner pending at the wrapper row iteration → true', () => {
    const gitDef = def([
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['a'] },
      { id: 'a', kind: 'agent-single' },
    ])
    const wrapperRow = run({ nodeId: 'gw', iteration: 3, status: 'awaiting_review' })
    const rows = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 3 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, rows, gitDef)).toBe(true)
    // pending at a different iteration → false
    const wrong = [wrapperRow, run({ id: '01P', nodeId: 'a', status: 'pending', iteration: 0 })]
    expect(wrapperHasFreshInnerWork(wrapperRow, wrong, gitDef)).toBe(false)
  })
})

describe('RFC-076 PR-A — wrapperInnerDescendants (G6 recursive expansion)', () => {
  test('nested git ∋ loop ∋ {agent,clarify} → all descendants collected', () => {
    const nested = def([
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['lw'] },
      { id: 'lw', kind: 'wrapper-loop', nodeIds: ['a', 'c'] },
      { id: 'a', kind: 'agent-single' },
      { id: 'c', kind: 'clarify' },
    ])
    const d = wrapperInnerDescendants('gw', nested)
    expect([...d].sort()).toEqual(['a', 'c', 'lw'])
  })

  test('non-wrapper / unknown id → empty set; cycle-safe', () => {
    const d = def([{ id: 'a', kind: 'agent-single' }])
    expect(wrapperInnerDescendants('a', d).size).toBe(0)
    expect(wrapperInnerDescendants('ghost', d).size).toBe(0)
    // defensive cycle: gw contains itself
    const cyclic = def([
      { id: 'gw', kind: 'wrapper-git', nodeIds: ['gw', 'x'] },
      { id: 'x', kind: 'agent-single' },
    ])
    expect([...wrapperInnerDescendants('gw', cyclic)].sort()).toEqual(['gw', 'x'])
  })
})
