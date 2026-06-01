// RFC-074 PR-A baseline — `isFresherNodeRun` current ordering, locked case-by-case.
//
// WHY THIS FILE EXISTS (regression intent):
//   RFC-074 retires the scalar `clarifyIteration` (cci) watermark. Phase 2
//   (PR-C, design §6.1) will change `isFresherNodeRun` from the current
//   3-level `(cci desc, retryIndex desc, id desc)` to either `(retryIndex, id)`
//   or pure `id`. Before we touch the comparator we LOCK its current row-pick
//   results here so PR-C can prove byte-equivalence (plan T-C1 / AC §11.3 C1-C4).
//
//   This is the EQUIVALENCE BASELINE, distinct from
//   `scheduler-fresher-noderun-cci.test.ts` (which reproduces specific live
//   incidents via the unified counter). Here we assert the full truth-table
//   PLUS the load-bearing question for PR-C: under the monotonic-ULID
//   invariant, does pure-id ordering pick the SAME row the comparator does?
//   A6 answers that and pins the single adversarial boundary where it would
//   NOT (out-of-causal-order ids), which is exactly the risk plan §6 flags
//   ("纯 id 排序未必总选对最新行").
//
//   If PR-C makes any of these RED, that is a SIGNAL to re-audit §6.1, not a
//   licence to edit the expectations.

import { describe, expect, test } from 'bun:test'
import { isFresherNodeRun } from '../src/services/scheduler'
import type { nodeRuns } from '../src/db/schema'

type Row = typeof nodeRuns.$inferSelect

// `isFresherNodeRun` reads only (id, clarifyIteration, retryIndex). We build a
// minimal row and cast — deliberately NOT mirroring the whole schema so this
// baseline does not drift when unrelated node_runs columns are added.
function row(id: string, cci = 0, retryIndex = 0): Row {
  return { id, clarifyIteration: cci, retryIndex } as unknown as Row
}

// The comparator induces a strict weak order; the "freshest" of a set is the
// element that is fresher-than every other (or, equivalently, the max under a
// left-fold with isFresherNodeRun as ">").
function freshestByComparator(rows: Row[]): Row {
  let winner: Row | undefined
  for (const r of rows) if (isFresherNodeRun(r, winner)) winner = r
  return winner!
}
function freshestByPureId(rows: Row[]): Row {
  return [...rows].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))[0]!
}
function freshestByRetryThenId(rows: Row[]): Row {
  return [...rows].sort((a, b) =>
    b.retryIndex !== a.retryIndex ? b.retryIndex - a.retryIndex : a.id < b.id ? 1 : -1,
  )[0]!
}

describe('RFC-074 PR-A baseline — isFresherNodeRun current (cci,retryIndex,id) order', () => {
  // A1 — base case: undefined incumbent means "first row seen always wins".
  test('A1: incumbent undefined → candidate is fresher', () => {
    expect(isFresherNodeRun(row('01AAA', 0, 0), undefined)).toBe(true)
  })

  // A2 — clarify rerun: a self-clarify rerun bumps cci; the post-answer row
  // (cci=1, retry=0) must outrank a retry-storm done row (cci=0, retry=9) at
  // the OLD generation. cci dominates retryIndex entirely.
  test('A2: clarify rerun — higher cci beats any retryIndex at lower cci', () => {
    const clarifyRerun = row('01CLARIFY', 1, 0)
    const retryStorm = row('01RETRY', 0, 9)
    expect(isFresherNodeRun(clarifyRerun, retryStorm)).toBe(true)
    expect(isFresherNodeRun(retryStorm, clarifyRerun)).toBe(false)
  })

  // A3 — cross-clarify rerun: post-RFC-064 the cross-clarify designer rerun
  // bumps the SAME unified counter, so the structural rule is identical to A2.
  // Locked separately to document the second provenance origin of a cci bump.
  test('A3: cross-clarify rerun — unified cci bump beats lower-cci done', () => {
    const crossRerun = row('01CROSS', 2, 0)
    const olderDone = row('01OLD', 1, 3)
    expect(isFresherNodeRun(crossRerun, olderDone)).toBe(true)
    expect(isFresherNodeRun(olderDone, crossRerun)).toBe(false)
  })

  // A4 — single-node retry / process-retry: SAME cci, higher retryIndex wins
  // (a newer process attempt of the same generation supersedes the older one).
  test('A4: same cci — higher retryIndex wins', () => {
    const newerAttempt = row('01R2', 2, 2)
    const olderAttempt = row('01R1', 2, 1)
    expect(isFresherNodeRun(newerAttempt, olderAttempt)).toBe(true)
    expect(isFresherNodeRun(olderAttempt, newerAttempt)).toBe(false)
  })

  // A5 — resume / tie-break: when (cci, retryIndex) tie, the monotonic ULID id
  // is the deterministic tie-break (newer insert wins). Equal id → NOT strictly
  // fresher (so the fold is stable and the comparator is irreflexive).
  test('A5: (cci,retry) tie → larger id wins; equal id is not fresher', () => {
    expect(isFresherNodeRun(row('01BBB', 0, 0), row('01AAA', 0, 0))).toBe(true)
    expect(isFresherNodeRun(row('01AAA', 0, 0), row('01BBB', 0, 0))).toBe(false)
    expect(isFresherNodeRun(row('01AAA', 0, 0), row('01AAA', 0, 0))).toBe(false)
  })

  // A6 — EQUIVALENCE ANCHOR for PR-C (design §6.1).
  //
  // A6a: the realistic invariant. cci only ever bumps FORWARD in wall-clock
  // time, and retries are created in time order, and ULIDs are monotonic with
  // creation time. Therefore the row the comparator calls freshest is ALSO the
  // max-ULID row and the max-(retryIndex,id) row. This is what makes PR-C's
  // switch to id-ordering safe in the field.
  test('A6a: monotonic-ULID set — comparator == pure-id == (retry,id)', () => {
    // ids ASSIGNED in causal order: each fresher generation gets a larger ULID.
    const set: Row[] = [
      row('01000', 0, 0), // gen0 first attempt
      row('01001', 0, 1), // gen0 retry
      row('01002', 1, 0), // gen1 (clarify rerun) — later in time, larger id
      row('01003', 1, 1), // gen1 retry — latest, largest id
    ]
    const byComparator = freshestByComparator(set)
    expect(byComparator.id).toBe('01003')
    // The whole point: all three pickers agree on the SAME row.
    expect(freshestByPureId(set).id).toBe(byComparator.id)
    expect(freshestByRetryThenId(set).id).toBe(byComparator.id)
  })

  // A6b: the adversarial boundary PR-C must NOT cross silently. If a STALE
  // low-cci row is ever assigned a LARGER id than a fresh high-cci row (i.e.
  // an id minted out of causal order, OR a cci raised in-place by UPDATE on an
  // older row without a new insert — cf. the RFC-074 incident, where reused
  // review rows desync cci), then pure-id ordering would pick the STALE row
  // while the comparator (correctly) picks by cci. This documents WHY PR-C
  // cannot blindly drop to pure-id; it must keep (retryIndex,id) or first
  // prove this state is unreachable.
  test('A6b: out-of-causal-order ids — comparator picks cci, pure-id diverges (boundary)', () => {
    const freshGen = row('01EARLY', 1, 0) // fresher (cci=1) but SMALLER id
    const staleGen = row('01LATER', 0, 0) // stale (cci=0) but LARGER id
    const set = [freshGen, staleGen]
    // Comparator: cci wins → the fresh row, regardless of id.
    expect(freshestByComparator(set).id).toBe('01EARLY')
    // Pure-id: larger id wins → the STALE row. DIVERGENCE is real here.
    expect(freshestByPureId(set).id).toBe('01LATER')
    // (retryIndex,id): retry tie → larger id → also the stale row. So even the
    // (retry,id) fallback diverges in this adversarial case; only cci saves it.
    expect(freshestByRetryThenId(set).id).toBe('01LATER')
    // => PR-C equivalence is contingent on causal-order ids. Provenance
    //    (consumed-run id) sidesteps this entirely (that is the RFC's thesis).
  })
})
