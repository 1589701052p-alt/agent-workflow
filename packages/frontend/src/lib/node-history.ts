// Builds the unified "Run history / 运行历史" list shown in the
// NodeDetailDrawer Stats tab.
//
// Background: a single workflow node id may produce many node_runs that
// differ on any of several orthogonal counters — loop `iteration`, RFC-005
// `reviewIteration`, process `retryIndex` — plus the clarify "generation".
// RFC-074 PR-C retired the `clarifyIteration` column; the clarify round is now
// DERIVED from ULID id-order (design §6.5): each clarify-driven rerun is minted
// at retryIndex=0, so the count of prior retry=0 top-level rows at the same
// (iteration, reviewIteration) is the round index — what the counter used to
// hold. We render one unified, always-visible timeline with the active row
// highlighted.

import type { NodeRun } from '@agent-workflow/shared'

/**
 * All sibling node_runs of the same workflow node, sorted by
 * (iteration, reviewIteration, id). RFC-074 PR-C: ULID id is the canonical
 * creation order, replacing the retired (clarifyIteration, retryIndex,
 * startedAt) tail. *Includes* the current run so the active row can be
 * highlighted in place. Excludes multi-process shard children (they belong to a
 * separate "shards" section above).
 */
export function nodeRunHistory(current: NodeRun, runs: readonly NodeRun[]): NodeRun[] {
  return runs
    .filter((r) => r.nodeId === current.nodeId && r.parentNodeRunId === null)
    .sort((a, b) => {
      if (a.iteration !== b.iteration) return a.iteration - b.iteration
      if (a.reviewIteration !== b.reviewIteration) return a.reviewIteration - b.reviewIteration
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
}

/**
 * RFC-074 PR-C: derive a run's clarify round (the value the retired
 * `clarifyIteration` counter held) from id-order. Each clarify-driven rerun is
 * a fresh retry=0 top-level insert, so the round = (number of retry=0 top-level
 * rows for the same node at the same (iteration, reviewIteration) whose id is
 * ≤ this run's id) − 1. A process retry (retryIndex>0) inherits the round of
 * the retry=0 row that anchors its generation. 0 = first generation.
 */
export function clarifyRoundForRun(run: NodeRun, runs: readonly NodeRun[]): number {
  const anchors = runs.filter(
    (r) =>
      r.nodeId === run.nodeId &&
      r.parentNodeRunId === null &&
      r.iteration === run.iteration &&
      r.reviewIteration === run.reviewIteration &&
      r.retryIndex === 0 &&
      r.id <= run.id,
  )
  return Math.max(0, anchors.length - 1)
}

interface IterationLabelOpts {
  t: (key: string, vars?: Record<string, string | number>) => string
}

/**
 * Joins the non-zero loop / review / clarify counters into a single label.
 * Retry index is appended only when >0 (process retry within that tuple).
 * All-zero tuple → `initial` — the very first attempt, no iteration counter
 * ever bumped.
 *
 * RFC-074 PR-C: the clarify round is no longer read off the row; the caller
 * passes the derived `clarifyRound` (see `clarifyRoundForRun`). The label
 * `iterClarify` covers both self- and cross-clarify flows.
 */
export function formatIterationLabel(
  run: NodeRun,
  opts: IterationLabelOpts,
  clarifyRound = 0,
): string {
  const parts: string[] = []
  if (run.iteration > 0) parts.push(opts.t('nodeDrawer.iterLoop', { n: run.iteration }))
  if (run.reviewIteration > 0)
    parts.push(opts.t('nodeDrawer.iterReview', { n: run.reviewIteration }))
  if (clarifyRound > 0) parts.push(opts.t('nodeDrawer.iterClarify', { n: clarifyRound }))
  if (parts.length === 0) parts.push(opts.t('nodeDrawer.iterInitial'))
  if (run.retryIndex > 0) parts.push(opts.t('nodeDrawer.iterRetry', { n: run.retryIndex }))
  return parts.join(' · ')
}
