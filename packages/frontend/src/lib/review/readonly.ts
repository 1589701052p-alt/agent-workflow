// RFC-013: read-only historical-version mode resolver.
//
// The detail page at `/reviews/$nodeRunId?version=<vid>` shows either:
//   - the current pending/decided version (no ?version query, or it matches
//     the current version's id), with all the review controls (approve /
//     reject / iterate, comment add/edit/delete, diff toggle), OR
//   - a historical version, in read-only mode (decision buttons + comment
//     write affordances hidden, diff toggle hidden, keyboard shortcuts off).
//
// `resolveReviewView` is the single source of truth for which mode the
// page is in. Pulled into its own pure function so it can be exercised by
// unit tests without rendering the page.
//
// RFC-149 additions (design §5):
//   - `ReviewPaneMode` — the single three-state writability discriminant both
//     review surfaces hand to <ReviewDocPane> (replaces the collapsible
//     `readonly` + `awaiting` boolean pair).
//   - `resolveRoundView` — the multi-doc twin of `resolveReviewView` for
//     `?round=<roundKey>` (same five-rule shape, incl. optimistic-historical
//     while the rounds list loads).
//   - `pickViewedVersion` / `pickViewedRoundDecision` — one-shot pickers that
//     replace the per-field `view.mode === 'historical' ? … : …` ternaries.

import type {
  DocVersion,
  DocVersionDecision,
  DocVersionWithBodyAndComments,
  ReviewRoundSummary,
} from '@agent-workflow/shared'

/**
 * RFC-149: writability mode of a review surface.
 *   - 'awaiting'   — current round, decision pending: fully writable.
 *   - 'decided'    — current round, already decided: write affordances stay
 *                    visible but are disabled (comments froze at the decision
 *                    boundary; decision buttons render greyed out).
 *   - 'historical' — read-only history view: every write affordance hidden.
 */
export type ReviewPaneMode = 'awaiting' | 'decided' | 'historical'

export type ReviewView =
  | { mode: 'current' }
  | {
      mode: 'historical'
      vid: string
      /** decision + index when the local versions list contained the vid; the
       *  read-only banner uses these to render `viewing version vN (rejected)`.
       *  When the versions array isn't loaded yet, these stay undefined and
       *  the UI falls back to placeholder labels until the network query
       *  resolves. */
      decision?: DocVersionDecision
      versionIndex?: number
    }
  | { mode: 'invalid'; requested: string }

/**
 * Decide which review view the page should render.
 *
 * Parameters intentionally do not include async query state — pass the
 * already-resolved `versions` array (or undefined when it's still loading).
 *
 * Rules (in order):
 *   1. Empty / undefined / empty-string `versionQuery` → `mode: 'current'`.
 *   2. `versionQuery === currentVersionId` → `mode: 'current'` (the link
 *      target for the "current" row in the list-page expand panel; we treat
 *      it identically to the no-query path so the banner doesn't appear).
 *   3. `versions === undefined` (not loaded yet) → `mode: 'historical'`
 *      optimistically; the network request for that vid will surface 404
 *      separately if it's bogus.
 *   4. Versions loaded + match found → `mode: 'historical'` with the
 *      version's decision + index pre-populated.
 *   5. Versions loaded + no match → `mode: 'invalid'`. The page reacts by
 *      showing a toast and replacing the URL with the no-query form.
 */
export function resolveReviewView(
  versionQuery: string | undefined,
  currentVersionId: string,
  versions: DocVersion[] | undefined,
): ReviewView {
  if (versionQuery === undefined || versionQuery === '') return { mode: 'current' }
  if (versionQuery === currentVersionId) return { mode: 'current' }
  if (versions === undefined) {
    return { mode: 'historical', vid: versionQuery }
  }
  const match = versions.find((v) => v.id === versionQuery)
  if (match === undefined) return { mode: 'invalid', requested: versionQuery }
  return {
    mode: 'historical',
    vid: match.id,
    decision: match.decision,
    versionIndex: match.versionIndex,
  }
}

// ---------------------------------------------------------------------------
// RFC-149 — multi-doc round view resolver (`?round=<roundKey>`).
// ---------------------------------------------------------------------------

export type ReviewRoundView =
  | { mode: 'current' }
  | {
      mode: 'historical'
      roundKey: string
      /** The matched round when the rounds list has loaded; stays undefined
       *  while the query is in flight and the UI renders placeholder labels
       *  (same optimistic-historical contract as `resolveReviewView`). */
      round?: ReviewRoundSummary
      /** 0-based index into the rounds array — drives the "round N" labels. */
      roundIndex?: number
    }
  | { mode: 'invalid'; requested: string }

/**
 * Decide which round view the multi-doc review page should render.
 *
 * Rules (in order, mirroring `resolveReviewView`):
 *   1. Empty / undefined / empty-string `roundQuery` → `mode: 'current'`.
 *   2. `rounds === undefined` (not loaded yet) → `mode: 'historical'`
 *      OPTIMISTICALLY. Deliberate RFC-149 behavior alignment: the multi-doc
 *      page used to block on a full-page spinner here while the single-doc
 *      page already rendered the read-only shell with placeholder labels.
 *   3. Match found + `isCurrent` → `mode: 'current'` (a `?round=` link to the
 *      current round is equivalent to no param — the interactive view renders).
 *   4. Match found + retired round → `mode: 'historical'` with the round +
 *      its index hydrated.
 *   5. Rounds loaded + no match → `mode: 'invalid'`. The page reacts with a
 *      one-shot warning and replaces the URL with the no-query form.
 */
export function resolveRoundView(
  roundQuery: string | undefined,
  rounds: ReviewRoundSummary[] | undefined,
): ReviewRoundView {
  if (roundQuery === undefined || roundQuery === '') return { mode: 'current' }
  if (rounds === undefined) {
    return { mode: 'historical', roundKey: roundQuery }
  }
  const roundIndex = rounds.findIndex((r) => r.roundKey === roundQuery)
  const match = roundIndex >= 0 ? rounds[roundIndex] : undefined
  if (match === undefined) return { mode: 'invalid', requested: roundQuery }
  if (match.isCurrent) return { mode: 'current' }
  return { mode: 'historical', roundKey: match.roundKey, round: match, roundIndex }
}

// ---------------------------------------------------------------------------
// RFC-149 — viewed-version / viewed-round-decision pickers.
//
// Both review surfaces render the same decision block (ReviewDecisionInfo) for
// either the CURRENT version/round or a HISTORICAL one. Before RFC-149 each
// field switched sources through its own `view.mode === 'historical' ? … : …`
// ternary (seven of them on the single-doc page, five on the multi-doc page),
// which let individual fields drift to the wrong source. One picker call now
// selects the whole object at once.
// ---------------------------------------------------------------------------

/** The decision fields both review surfaces feed into <ReviewDecisionInfo>. */
export interface ViewedDecision {
  decision: DocVersionDecision | undefined
  decisionReason: string | null | undefined
  decidedAt: number | null | undefined
  decidedBy: string | null | undefined
  decidedByRole: DocVersion['decidedByRole']
}

/** Single-doc shape: decision fields + the viewed version's index. */
export interface ViewedVersion extends ViewedDecision {
  versionIndex: number | undefined
}

/**
 * Pick every viewed-version field in one shot (single-doc page).
 *
 * Historical mode prefers the values `resolveReviewView` hydrated from the
 * versions list (available before the version-detail request lands), falling
 * back to the historical detail payload; current/invalid modes read the
 * current version. Fields stay `undefined` while their source is loading —
 * callers keep their existing placeholder fallbacks.
 */
export function pickViewedVersion(
  view: ReviewView,
  historicalDetail: DocVersionWithBodyAndComments | undefined,
  current: DocVersion | undefined,
): ViewedVersion {
  if (view.mode === 'historical') {
    return {
      decision: view.decision ?? historicalDetail?.decision,
      decisionReason: historicalDetail?.decisionReason,
      decidedAt: historicalDetail?.decidedAt,
      decidedBy: historicalDetail?.decidedBy,
      decidedByRole: historicalDetail?.decidedByRole,
      versionIndex: view.versionIndex ?? historicalDetail?.versionIndex,
    }
  }
  return {
    decision: current?.decision,
    decisionReason: current?.decisionReason,
    decidedAt: current?.decidedAt,
    decidedBy: current?.decidedBy,
    decidedByRole: current?.decidedByRole,
    versionIndex: current?.versionIndex,
  }
}

/**
 * Multi-doc sibling of `pickViewedVersion` (same return shape minus the
 * version index — a round has no single version index). Historical mode reads
 * the round-level decision fields the rounds endpoint stamped; current /
 * invalid modes read the current doc_version's round-level fields.
 */
export function pickViewedRoundDecision(
  view: ReviewRoundView,
  current: DocVersion | undefined,
): ViewedDecision {
  if (view.mode === 'historical') {
    return {
      decision: view.round?.decision,
      decisionReason: view.round?.decisionReason,
      decidedAt: view.round?.decidedAt,
      decidedBy: view.round?.decidedBy,
      decidedByRole: view.round?.decidedByRole,
    }
  }
  return {
    decision: current?.decision,
    decisionReason: current?.decisionReason,
    decidedAt: current?.decidedAt,
    decidedBy: current?.decidedBy,
    decidedByRole: current?.decidedByRole,
  }
}
