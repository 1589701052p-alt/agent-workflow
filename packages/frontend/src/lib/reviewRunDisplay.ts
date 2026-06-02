// RFC-078 — pure display helper for a review node_run's timeline timing.
//
// A review row's raw `startedAt` is the slot-first-open tick (pinned, never
// re-stamped across refresh/iterate reuse) and `finishedAt` is the human
// approve time, so rendering them raw is misleading (start can predate the
// reviewed agent run by hours; "duration" conflates human think-time with
// reruns). The backend derives `reviewRoundStartedAt` (current round's content
// produced) + `reviewDecidedAt` (when decided); this helper turns those into
// what the UI shows. Each caller formats the numbers (seconds rounding differs
// between the compact table and the drawer), so we return raw ms.
//
// `durationMs` is the single value both surfaces render in the "耗时" column:
// a review's human-review wait and a non-review row's finished−started share
// it and format identically (plain "{{d}}s" / em-dash) — the column no longer
// marks 人工 vs 非人工.

import type { NodeRun } from '@agent-workflow/shared'

export interface ReviewRunDisplay {
  /** True for review rows that carry a derived round anchor. */
  isReview: boolean
  /** ms timestamp to render as the run's "start" (round anchor for reviews, else startedAt), or null. */
  displayStartedAt: number | null
  /** Human-review wait (decided − round start) in ms; null while awaiting a decision or for non-review rows. */
  reviewWaitMs: number | null
  /**
   * ms to render in the timeline "耗时" column (null → em-dash). Review rows:
   * the human-review wait (= reviewWaitMs). Every other row: finished − started.
   * Both kinds share this one field so the column renders them identically and
   * no longer marks 人工 vs 非人工.
   */
  durationMs: number | null
}

export function reviewRunDisplay(
  run: Pick<NodeRun, 'startedAt' | 'finishedAt' | 'reviewRoundStartedAt' | 'reviewDecidedAt'>,
): ReviewRunDisplay {
  const roundStart = run.reviewRoundStartedAt ?? null
  const isReview = roundStart != null
  const displayStartedAt = roundStart ?? run.startedAt ?? null
  const decided = run.reviewDecidedAt ?? null
  const reviewWaitMs = isReview && decided != null ? decided - roundStart : null
  const started = run.startedAt ?? null
  const finished = run.finishedAt ?? null
  const durationMs = isReview
    ? reviewWaitMs
    : started != null && finished != null
      ? finished - started
      : null
  return { isReview, displayStartedAt, reviewWaitMs, durationMs }
}
