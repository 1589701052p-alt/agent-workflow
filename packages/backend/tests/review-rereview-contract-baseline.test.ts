// RFC-074 PR-A baseline — review re-review contract, locked at the helpers
// PR-B rewrites/deletes (A13-A17).
//
// WHY THIS FILE EXISTS (regression intent):
//   The integration-level review contract (approve propagates, iterate mints,
//   reject terminates, sibling cascade) is already locked by the combination
//   scenarios (S1/S5/S9/S16) and the existing review-* suites. What PR-B
//   actually TOUCHES is two pure helpers:
//     - `isReviewClarifyAlignedWithUpstream` — the cci-based short-circuit
//       that `dispatchReviewNode` uses to decide "prior approval still covers
//       the upstream → skip re-review". PR-B DELETES this (plan T-B9), letting
//       provenance freshness decide instead. We lock its full truth table so
//       PR-B can prove the deletion preserves the observable re-review
//       contract (RFC-005 US-2: upstream genuinely advanced → re-review fires;
//       upstream unchanged → no spurious re-review).
//     - `pickFreshestReviewRun` — dual-pick (freshest reuse row + freshest
//       done row) PR-B keeps but feeds a unified picker. Locked so the
//       reuse/latestDone selection does not silently drift.
//
//   When PR-B removes `isReviewClarifyAlignedWithUpstream`, A13-A16 are
//   expected to be deleted WITH it — but only after the provenance equivalent
//   reproduces the same fire/skip decisions (B18). They are the before-photo.

import { describe, expect, test } from 'bun:test'
import { isReviewClarifyAlignedWithUpstream, pickFreshestReviewRun } from '../src/services/review'
import type { nodeRuns } from '../src/db/schema'

type Row = typeof nodeRuns.$inferSelect

// Helpers read only (id, clarifyIteration, retryIndex, status, parentNodeRunId).
function row(opts: {
  id?: string
  cci?: number
  retryIndex?: number
  status?: string
  parentNodeRunId?: string | null
}): Row {
  return {
    id: opts.id ?? '01X',
    clarifyIteration: opts.cci ?? 0,
    retryIndex: opts.retryIndex ?? 0,
    status: opts.status ?? 'done',
    parentNodeRunId: opts.parentNodeRunId ?? null,
  } as unknown as Row
}

describe('RFC-074 PR-A baseline — review re-review contract (A13-A17)', () => {
  // A13 — no prior approval: latestDone undefined → NOT aligned → the cascade
  // pending review row must dispatch (there is nothing to short-circuit).
  test('A13: latestDone undefined → false (must dispatch)', () => {
    expect(isReviewClarifyAlignedWithUpstream(undefined, row({ cci: 5 }))).toBe(false)
  })

  // A14 — prior approval still covers upstream: latestDone.cci >= sourceRun.cci
  // → aligned → short-circuit, NO spurious re-review. (The healthy steady
  // state after an approve when upstream has not moved.)
  test('A14: approval cci >= upstream cci → true (short-circuit, no re-review)', () => {
    expect(isReviewClarifyAlignedWithUpstream(row({ cci: 8 }), row({ cci: 8 }))).toBe(true)
    expect(isReviewClarifyAlignedWithUpstream(row({ cci: 9 }), row({ cci: 8 }))).toBe(true)
  })

  // A15 — upstream genuinely advanced past the approval (RFC-005 US-2):
  // latestDone.cci < sourceRun.cci → NOT aligned → re-review fires. This is the
  // contract provenance must preserve: a real upstream rerun re-opens review.
  // (It is ALSO the shape the incident produced via desync — latestDone.cci=6
  // stamped against an upstream at cci=8 — which is why the fix is to make the
  // review's consumed-run point at the ACTUAL reviewed run, not to change this
  // function's logic.)
  test('A15: approval cci < upstream cci → false (US-2 re-review fires)', () => {
    expect(isReviewClarifyAlignedWithUpstream(row({ cci: 6 }), row({ cci: 8 }))).toBe(false)
  })

  // A16 — clarify-free baseline (cci stays 0 everywhere): reduces to "any prior
  // done approval is decisive" (RFC-052 original short-circuit).
  test('A16: cci=0 baseline → reduces to latestDone present', () => {
    expect(isReviewClarifyAlignedWithUpstream(row({ cci: 0 }), row({ cci: 0 }))).toBe(true)
  })

  // A17 — pickFreshestReviewRun dual-pick: `reuse` = freshest top-level row by
  // (cci,retry,id) regardless of status; `latestDone` = freshest top-level row
  // that is `done`. Fan-out child rows (parentNodeRunId != null) are excluded
  // from BOTH even when they would rank highest.
  test('A17: reuse = freshest top-level; latestDone = freshest done; children excluded', () => {
    const done0 = row({ id: '01DONE0', cci: 0, status: 'done' })
    const awaiting1 = row({ id: '01AWAIT1', cci: 1, status: 'awaiting_review' })
    const childHigh = row({ id: '01CHILD2', cci: 2, status: 'done', parentNodeRunId: '01AWAIT1' })
    const { reuse, latestDone } = pickFreshestReviewRun([done0, awaiting1, childHigh])
    // Freshest top-level overall is the cci=1 awaiting row (child cci=2 excluded).
    expect(reuse?.id).toBe('01AWAIT1')
    // Freshest DONE top-level is the cci=0 done row (awaiting is not done; child excluded).
    expect(latestDone?.id).toBe('01DONE0')
  })
})
