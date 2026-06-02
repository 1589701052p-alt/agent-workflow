// RFC-078 — pins the pure display helper that decides what a review node_run's
// timeline row shows. The compact NodeRunsTable (tasks.detail.tsx) and the
// NodeDetailDrawer both call reviewRunDisplay; if a refactor regresses it, both
// surfaces silently fall back to the misleading pinned started_at / compute
// duration (the original bug — task 01KT1HDYV6RA8EJGY5BSE20MH9 rev_cbkatx showed
// a 25h "duration" and a start time 25h before the reviewed run).
//
// Also pins `durationMs`, the single value both surfaces format for the "耗时"
// column. Per the "耗时列不用标记人工还是非人工" request, a review's human-review
// wait and a non-review row's finished−started share this one field and render
// identically (plain "{{d}}s" / em-dash) — there is no longer a 人工/(review)
// marker. Awaiting reviews and still-running compute rows both yield null
// (→ em-dash); finishedAt (the human approve tick) is deliberately ignored for
// a review's durationMs.

import { describe, expect, test } from 'vitest'
import { reviewRunDisplay } from '../src/lib/reviewRunDisplay'

describe('RFC-078 reviewRunDisplay', () => {
  test('non-review row (no round anchor), unfinished: falls back to startedAt, no wait/duration', () => {
    expect(
      reviewRunDisplay({
        startedAt: 5000,
        finishedAt: null,
        reviewRoundStartedAt: null,
        reviewDecidedAt: null,
      }),
    ).toEqual({
      isReview: false,
      displayStartedAt: 5000,
      reviewWaitMs: null,
      durationMs: null,
    })
    // absent optional review fields behave the same
    expect(reviewRunDisplay({ startedAt: 5000, finishedAt: null })).toEqual({
      isReview: false,
      displayStartedAt: 5000,
      reviewWaitMs: null,
      durationMs: null,
    })
  })

  test('non-review finished row: durationMs = finished − started (compute span)', () => {
    expect(
      reviewRunDisplay({
        startedAt: 5000,
        finishedAt: 8000,
        reviewRoundStartedAt: null,
        reviewDecidedAt: null,
      }),
    ).toEqual({
      isReview: false,
      displayStartedAt: 5000,
      reviewWaitMs: null,
      durationMs: 3000,
    })
  })

  test('awaiting review: round anchor (not pinned startedAt); wait + durationMs null → em-dash', () => {
    // startedAt=100 is the misleading pinned slot time; anchor=9000 is content.
    expect(
      reviewRunDisplay({
        startedAt: 100,
        finishedAt: null,
        reviewRoundStartedAt: 9000,
        reviewDecidedAt: null,
      }),
    ).toEqual({
      isReview: true,
      displayStartedAt: 9000,
      reviewWaitMs: null,
      durationMs: null,
    })
  })

  test('decided review: durationMs = wait = decided − round anchor (human time, ignores finishedAt)', () => {
    // finishedAt=99999 (the human approve tick) must NOT leak into durationMs —
    // the row shows the 600ms human-review wait, not a 99899ms raw span.
    expect(
      reviewRunDisplay({
        startedAt: 100,
        finishedAt: 99999,
        reviewRoundStartedAt: 9000,
        reviewDecidedAt: 9600,
      }),
    ).toEqual({
      isReview: true,
      displayStartedAt: 9000,
      reviewWaitMs: 600,
      durationMs: 600,
    })
  })

  test('review anchor of 0 still counts as a review (nullish, not falsy)', () => {
    const d = reviewRunDisplay({
      startedAt: null,
      finishedAt: null,
      reviewRoundStartedAt: 0,
      reviewDecidedAt: 0,
    })
    expect(d.isReview).toBe(true)
    expect(d.displayStartedAt).toBe(0)
    expect(d.reviewWaitMs).toBe(0)
    expect(d.durationMs).toBe(0)
  })

  test('null startedAt and no anchor → displayStartedAt + durationMs null', () => {
    expect(reviewRunDisplay({ startedAt: null, finishedAt: null })).toEqual({
      isReview: false,
      displayStartedAt: null,
      reviewWaitMs: null,
      durationMs: null,
    })
  })
})
