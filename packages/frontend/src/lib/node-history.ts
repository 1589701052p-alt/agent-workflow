// Builds the unified "Run history / 运行历史" list shown in the
// NodeDetailDrawer Stats tab.
//
// Background: a single workflow node id may produce many node_runs that
// differ on any of five orthogonal counters — loop `iteration`, RFC-005
// `reviewIteration`, RFC-023 `clarifyIteration`, RFC-056 `crossClarifyIteration`,
// or process `retryIndex`. We used to render iterations and retries in
// two separate boxes, but retries always also showed up in the iteration
// list, so the boxes were redundant in the mixed case and just confusing.
// One unified, always-visible timeline — with the active row highlighted —
// fits both pure-retry and mixed cases.

import type { NodeRun } from '@agent-workflow/shared'

/**
 * All sibling node_runs of the same workflow node, sorted by
 * (iteration, reviewIteration, clarifyIteration, crossClarifyIteration,
 * retryIndex, startedAt). *Includes* the current run so the active row
 * can be highlighted in place. Excludes multi-process shard children
 * (they belong to a separate "shards" section above).
 */
export function nodeRunHistory(current: NodeRun, runs: readonly NodeRun[]): NodeRun[] {
  return runs
    .filter((r) => r.nodeId === current.nodeId && r.parentNodeRunId === null)
    .sort((a, b) => {
      if (a.iteration !== b.iteration) return a.iteration - b.iteration
      if (a.reviewIteration !== b.reviewIteration) return a.reviewIteration - b.reviewIteration
      // RFC-064: unified clarifyIteration covers both self-clarify (RFC-023)
      // and cross-clarify (RFC-056) rounds; the per-kind label split has been
      // collapsed (option D1 from design.md §10.5). Mint helpers
      // (mintQuestionerRerun / triggerDesignerRerun / cascadeDownstream...)
      // now bump the single field, so the all-zero branch in
      // formatIterationLabel correctly excludes any minted rerun row.
      if (a.clarifyIteration !== b.clarifyIteration) return a.clarifyIteration - b.clarifyIteration
      if (a.retryIndex !== b.retryIndex) return a.retryIndex - b.retryIndex
      const at = a.startedAt ?? Number.POSITIVE_INFINITY
      const bt = b.startedAt ?? Number.POSITIVE_INFINITY
      return at - bt
    })
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
 * RFC-064: under the unified clarifyIteration, the previously-separate
 * `crossClarifyIteration` chip is gone — the renderer no longer
 * distinguishes self vs cross clarify rounds at the label level (design.md
 * §10.5 option D1). The label `iterClarify` covers both flows.
 */
export function formatIterationLabel(run: NodeRun, opts: IterationLabelOpts): string {
  const parts: string[] = []
  if (run.iteration > 0) parts.push(opts.t('nodeDrawer.iterLoop', { n: run.iteration }))
  if (run.reviewIteration > 0)
    parts.push(opts.t('nodeDrawer.iterReview', { n: run.reviewIteration }))
  if (run.clarifyIteration > 0)
    parts.push(opts.t('nodeDrawer.iterClarify', { n: run.clarifyIteration }))
  if (parts.length === 0) parts.push(opts.t('nodeDrawer.iterInitial'))
  if (run.retryIndex > 0) parts.push(opts.t('nodeDrawer.iterRetry', { n: run.retryIndex }))
  return parts.join(' · ')
}
