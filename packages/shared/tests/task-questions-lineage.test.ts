// RFC-120 Codex F1 — locks `resolveHandlerRun`: the PRECISE handler lineage
// (not a bare "freshest run >= trigger" comparison) used to derive an entry's
// execution phase.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * null effective target OR null trigger → null (unscheduled → pending).
//   * the trigger run itself is the handler when nothing newer matches.
//   * a process-retry of the trigger (same node/iter, cause='process-retry',
//     id > anchor) IS in the window → freshest wins.
//   * **a LATER unrelated clarify-triggered rerun (a new round/answer on the
//     same node, cause ∈ NEW_CLARIFY_TRIGGER_CAUSES, id > anchor) is the WINDOW
//     UPPER BOUND and is EXCLUDED** — so it cannot drag an already
//     awaiting_confirm entry back to processing (the core F1 bug).
//   * fanout: the top-level parent run represents the handler; shard children
//     (parentNodeRunId != null) are not picked as the representative.
//   * runs on a different node / different iteration are ignored, and runs with
//     id < anchor (the pre-clarify original run) are below the window.

import { describe, expect, test } from 'bun:test'
import { resolveHandlerRun, type RunLineageView } from '../src/task-questions'

const R = (id: string, over: Partial<RunLineageView> = {}): RunLineageView => ({
  id,
  nodeId: 'design',
  iteration: 0,
  loopIter: 0,
  rerunCause: 'cross-clarify-answer',
  status: 'done',
  startedAt: 1,
  hasOutput: true,
  parentNodeRunId: null,
  ...over,
})

const base = { effectiveTargetNodeId: 'design', iteration: 0, loopIter: 0 }

describe('resolveHandlerRun', () => {
  test('null effective target → null', () => {
    expect(
      resolveHandlerRun({
        ...base,
        effectiveTargetNodeId: null,
        triggerRunId: 'r1',
        runs: [R('r1')],
      }),
    ).toBeNull()
  })

  test('null trigger → null', () => {
    expect(resolveHandlerRun({ ...base, triggerRunId: null, runs: [R('r1')] })).toBeNull()
  })

  test('trigger run is the handler', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [R('r1', { status: 'done', hasOutput: true })],
    })
    expect(out).toEqual({ status: 'done', startedAt: 1, hasOutput: true })
  })

  test('trigger still pending → its pending view', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [R('r1', { status: 'pending', startedAt: null, hasOutput: false })],
    })
    expect(out).toEqual({ status: 'pending', startedAt: null, hasOutput: false })
  })

  test('process-retry of the trigger is in-window → freshest wins', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [
        R('r1', { status: 'failed', hasOutput: false }),
        R('r2', { rerunCause: 'process-retry', status: 'running', hasOutput: false }),
      ],
    })
    expect(out).toEqual({ status: 'running', startedAt: 1, hasOutput: false })
  })

  test('F1: a later unrelated clarify rerun is the upper bound → EXCLUDED (stays awaiting_confirm)', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [
        R('r1', { status: 'done', hasOutput: true }), // our handler — done w/ output
        R('r3', { rerunCause: 'cross-clarify-answer', status: 'running', hasOutput: false }), // a NEW round's rerun
      ],
    })
    // Must return r1 (done+output), NOT r3 (running) — else the entry would be
    // dragged back to processing by an unrelated newer round.
    expect(out).toEqual({ status: 'done', startedAt: 1, hasOutput: true })
  })

  test('fanout: top-level parent is the representative, shard child ignored', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r1',
      runs: [
        R('r1', { status: 'running', hasOutput: false, parentNodeRunId: null }),
        R('r2', { status: 'done', hasOutput: true, parentNodeRunId: 'r1' }), // shard child
      ],
    })
    expect(out).toEqual({ status: 'running', startedAt: 1, hasOutput: false })
  })

  test('runs below the anchor (pre-clarify original) are excluded', () => {
    const out = resolveHandlerRun({
      ...base,
      triggerRunId: 'r2',
      runs: [
        R('r1', { status: 'done', hasOutput: true }), // original run before clarify
        R('r2', { status: 'running', hasOutput: false }), // the clarify-triggered handler
      ],
    })
    expect(out).toEqual({ status: 'running', startedAt: 1, hasOutput: false })
  })

  test('different node / iteration ignored → null when none match', () => {
    expect(
      resolveHandlerRun({
        ...base,
        triggerRunId: 'r1',
        runs: [R('r1', { nodeId: 'other' }), R('r2', { iteration: 1 })],
      }),
    ).toBeNull()
  })
})
