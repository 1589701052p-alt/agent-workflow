// RFC-056 patch 2026-05-25 — `isFresherNodeRun` must consult
// crossClarifyIteration.
//
// Live task `01KS7FAW50V9KV2SPH859NV8ER` failed with
// `review-source-port-missing` because the comparator only keyed on
// `(clarifyIteration, retryIndex, id)`, NOT crossClarifyIteration. Two
// rows for `agent_b48d63` at iteration=0:
//
//   - done    (cli=0, cci=0, retry=1) — RFC-042 same-session followup,
//                                       emitted `<workflow-clarify>` only,
//                                       NO `docpath` port row
//   - pending (cli=0, cci=1, retry=0) — mintQuestionerRerun after user
//                                       submitted cross-clarify (continue)
//
// Old comparator: cli ties → retryIndex 1 > 0 → picks the stale done row.
// `dispatchReviewNode` (review.ts:405) then reads zero `docpath` outputs
// and fails the task.
//
// Fix: comparator order is now `cli → cci → retryIndex → id`. The cci
// bump from cross-clarify mint helpers is sufficient on its own to beat
// prior process-retry rows — `triggerDesignerRerun` / `mintQuestionerRerun`
// / `cascadeDownstreamFromDesigner` `retry_index = max+1` bumps are still
// in place as belt-and-suspenders but no longer the only thing keeping
// the freshness shield up.
//
// This file locks the comparator's 4 ordering rules. If any case turns
// red, investigate before relaxing — the rules pair with all six prior
// RFC-056 patches.

import { describe, expect, test } from 'bun:test'
import { isFresherNodeRun } from '../src/services/scheduler'
import type { nodeRuns } from '../src/db/schema'

type Row = typeof nodeRuns.$inferSelect

function mkRow(opts: {
  id: string
  clarifyIteration?: number
  crossClarifyIteration?: number
  retryIndex?: number
  status?: string
}): Row {
  return {
    id: opts.id,
    taskId: 't',
    nodeId: 'n',
    parentNodeRunId: null,
    iteration: 0,
    shardKey: null,
    retryIndex: opts.retryIndex ?? 0,
    status: (opts.status ?? 'done') as Row['status'],
    startedAt: 0,
    finishedAt: null,
    pid: null,
    exitCode: null,
    errorMessage: null,
    promptText: null,
    tokInput: null,
    tokOutput: null,
    tokCacheCreate: null,
    tokCacheRead: null,
    tokTotal: null,
    preSnapshot: null,
    reviewIteration: 0,
    clarifyIteration: opts.clarifyIteration ?? 0,
    opencodeSessionId: null,
    inventorySnapshotJson: null,
    wrapperProgressJson: null,
    injectedMemoriesJson: null,
    portValidationFailuresJson: null,
    crossClarifyIteration: opts.crossClarifyIteration ?? 0,
  } as unknown as Row
}

describe('RFC-056 patch 2026-05-25 — isFresherNodeRun must consult crossClarifyIteration', () => {
  test('live task 01KS7FAW reproducer: cci-bumped pending beats prior retry-bumped done', () => {
    // The exact shape of task 01KS7FAW50V9KV2SPH859NV8ER:
    //   - done    (cli=0, cci=0, retry=1) — `<workflow-clarify>`-only, no docpath
    //   - pending (cli=0, cci=1, retry=0) — post-submit questioner rerun
    // Pre-patch: comparator chose the done row (retry=1 > 0). Downstream
    // `dispatchReviewNode` failed with review-source-port-missing.
    const done = mkRow({
      id: '01KS7GPRZ11RWZ6NTXN2VVAAKR',
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      retryIndex: 1,
      status: 'done',
    })
    const pending = mkRow({
      id: '01KSEX6H6A8YPK2S9QA3PDSHY0',
      clarifyIteration: 0,
      crossClarifyIteration: 1,
      retryIndex: 0,
      status: 'pending',
    })
    expect(isFresherNodeRun(pending, done)).toBe(true)
    expect(isFresherNodeRun(done, pending)).toBe(false)
  })

  test('clarifyIteration outranks crossClarifyIteration', () => {
    // A fresh self-clarify rerun (cli=1) must beat any prior cci-bumped
    // row at cli=0 — even if cci is much larger. Self-clarify is the
    // newest user intervention chronologically.
    const olderCrossClarifyMint = mkRow({
      id: 'A',
      clarifyIteration: 0,
      crossClarifyIteration: 5,
      retryIndex: 0,
    })
    const newerSelfClarifyMint = mkRow({
      id: 'B',
      clarifyIteration: 1,
      crossClarifyIteration: 0,
      retryIndex: 0,
    })
    expect(isFresherNodeRun(newerSelfClarifyMint, olderCrossClarifyMint)).toBe(true)
    expect(isFresherNodeRun(olderCrossClarifyMint, newerSelfClarifyMint)).toBe(false)
  })

  test('crossClarifyIteration outranks retryIndex at same clarifyIteration', () => {
    // Same shape as the live-task reproducer but with retryIndex inflated
    // to a much larger value (e.g. RFC-042 followup storm pushed it to 9).
    // Pre-patch the cci=1 mint would still lose to retry=9.
    const oldHighRetry = mkRow({
      id: 'A',
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      retryIndex: 9,
    })
    const freshCciMint = mkRow({
      id: 'B',
      clarifyIteration: 0,
      crossClarifyIteration: 1,
      retryIndex: 0,
    })
    expect(isFresherNodeRun(freshCciMint, oldHighRetry)).toBe(true)
    expect(isFresherNodeRun(oldHighRetry, freshCciMint)).toBe(false)
  })

  test('tie on (cli, cci) falls through to retryIndex then ulid (legacy semantics)', () => {
    // No cross-clarify happened (cci=0 on both) and no self-clarify rerun
    // (cli=0 on both): comparator must still pick by retryIndex then ulid.
    // Locks the cci=0-everywhere subset to byte-identical legacy behavior.
    const olderRetry = mkRow({
      id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      retryIndex: 0,
    })
    const newerRetry = mkRow({
      id: '01BBBBBBBBBBBBBBBBBBBBBBBB',
      clarifyIteration: 0,
      crossClarifyIteration: 0,
      retryIndex: 1,
    })
    expect(isFresherNodeRun(newerRetry, olderRetry)).toBe(true)
    expect(isFresherNodeRun(olderRetry, newerRetry)).toBe(false)

    // Same (cli, cci, retry) → ulid tiebreak, monotonic last-write wins.
    const a = mkRow({ id: '01AAAAAAAAAAAAAAAAAAAAAAAA' })
    const b = mkRow({ id: '01BBBBBBBBBBBBBBBBBBBBBBBB' })
    expect(isFresherNodeRun(b, a)).toBe(true)
    expect(isFresherNodeRun(a, b)).toBe(false)
  })

  test('undefined incumbent: any candidate is fresher (initial seed semantics)', () => {
    // Sanity: the first row in any latestPerNode loop must be accepted.
    const r = mkRow({ id: 'A' })
    expect(isFresherNodeRun(r, undefined)).toBe(true)
  })
})
