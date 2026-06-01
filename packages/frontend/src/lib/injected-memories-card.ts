// RFC-046 — pure helpers backing <InjectedMemoriesCard>. Kept separate
// from the component so each branch is unit-testable in isolation.

import type { InjectedMemorySnapshot, NodeRun } from '@agent-workflow/shared'

/**
 * Which workflow-node kinds ever call the runner inject path (and so can
 * meaningfully show "injected memories"). Mirrors `isAgentRunKind` from the
 * backend but lives in the frontend so the component can early-return for
 * non-agent runs without an extra prop. Defensive on unknown strings: the
 * scheduler may grow new kinds, but only the agent ones need this card.
 */
export function isAgentKind(kind: string | null | undefined): boolean {
  if (kind === null || kind === undefined) return false
  // RFC-060 PR-E: agent-multi removed; agent-single is the only agent kind.
  return kind === 'agent-single'
}

/**
 * Three render branches for the card body:
 *   - 'captured'   : runner persisted a non-empty array; render the list.
 *   - 'empty'      : runner persisted an empty array (inject succeeded but
 *                    no scope had approved memories — distinct from null).
 *   - 'pre-rfc046' : column was NULL (pre-RFC-046 row or runner failed to
 *                    persist). Show the "Not captured" disclaimer.
 *
 * `undefined` (api response without the field, e.g. older clients) is
 * treated identically to null.
 */
export function decideStatus(
  list: readonly InjectedMemorySnapshot[] | null | undefined,
): 'captured' | 'empty' | 'pre-rfc046' {
  if (list === null || list === undefined) return 'pre-rfc046'
  if (list.length === 0) return 'empty'
  return 'captured'
}

export interface GroupedSnapshots {
  agent: InjectedMemorySnapshot[]
  workflow: InjectedMemorySnapshot[]
  repo: InjectedMemorySnapshot[]
  global: InjectedMemorySnapshot[]
}

/** Stable display order: most-specific → most-general. */
export const SCOPE_ORDER = ['agent', 'workflow', 'repo', 'global'] as const
export type ScopeKey = (typeof SCOPE_ORDER)[number]

export function groupByScope(list: readonly InjectedMemorySnapshot[]): GroupedSnapshots {
  const out: GroupedSnapshots = { agent: [], workflow: [], repo: [], global: [] }
  for (const m of list) {
    out[m.scopeType].push(m)
  }
  return out
}

/**
 * Truncate body markdown for the summary preview. The full body is rendered
 * in the row's expanded `<details>` via MarkdownRenderer; the summary just
 * wants a single-line teaser. Strips newlines so multi-paragraph bodies
 * collapse cleanly.
 */
export function previewOf(bodyMd: string, max = 200): string {
  const oneLine = bodyMd.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return oneLine.slice(0, max) + '…'
}

/**
 * RFC-046 + RFC-042: detect a same-session envelope-followup retry. The
 * runner's followup path copies attempt 0's snapshot to the followup row,
 * so the UI labels it "Inherited from attempt 0" to make that contract
 * legible. We can't infer this from `injectedMemories` alone — multiple
 * legitimate paths can produce identical lists across attempts — so the
 * caller must also know which attempts share the same opencodeSessionId.
 *
 * Returns true iff `run.retryIndex > 0` AND the run shares
 * `opencodeSessionId` with the retry_index=0 sibling that anchors its
 * generation (see `findFirstAttemptSibling`).
 */
export function isFollowupInherit(run: NodeRun, attempt0: NodeRun | undefined): boolean {
  if (run.retryIndex === 0) return false
  if (attempt0 === undefined) return false
  if (attempt0.id === run.id) return false
  const sid = run.opencodeSessionId
  if (sid === null || sid === '') return false
  return attempt0.opencodeSessionId === sid
}

/**
 * Pick the retry_index=0 sibling that ANCHORS the active run's clarify
 * generation, scoped to the same (nodeId, iteration, shardKey,
 * reviewIteration). RFC-074 PR-C: the retired clarifyIteration counter used to
 * be the fifth key; the generation is now id-ordered — the anchor is the
 * retry=0 row with the LARGEST id not exceeding the active run's id (mirrors
 * backend memoryInject.loadInjectedSnapshotFromFirstAttempt). Using only nodeId
 * would surface the wrong attempt 0 across iterations / shards.
 */
export function findFirstAttemptSibling(
  run: NodeRun,
  allRuns: readonly NodeRun[],
): NodeRun | undefined {
  let anchor: NodeRun | undefined
  for (const r of allRuns) {
    if (r.nodeId !== run.nodeId) continue
    if (r.iteration !== run.iteration) continue
    if (r.shardKey !== run.shardKey) continue
    if (r.reviewIteration !== run.reviewIteration) continue
    if (r.retryIndex !== 0) continue
    if (r.id > run.id) continue
    if (anchor === undefined || r.id > anchor.id) anchor = r
  }
  return anchor
}
