// RFC-074 — provenance-based node freshness (PR-B).
//
// Replaces the scalar `clarify_iteration` (cci) watermark. A node_run records
// `consumed_upstream_runs_json = { upstreamNodeId: nodeRunId }` at its single
// content read-point (resolveUpstreamInputs for agents, sourceRun for review
// nodes). The node is "fresh" iff every upstream run it consumed is STILL the
// freshest done row of that upstream — computed read-time here, replacing the
// two speculative-mint cascade layers (cascadeDownstreamFromDesigner +
// applyClarifyFreshnessInvariant).
//
// Pure module: only the nodeRuns row TYPE is imported (no DB, no scheduler), so
// both functions are trivially unit-testable and there is no import cycle with
// scheduler.ts (which imports from here).

import type { nodeRuns } from '../db/schema'

type NodeRunRow = typeof nodeRuns.$inferSelect

/**
 * Parse `node_runs.consumed_upstream_runs_json` into a `{ upstreamNodeId:
 * nodeRunId }` map. Degrades to `{}` (an empty map ⇒ always fresh) on null,
 * empty string, malformed JSON, non-object shapes, and non-string values —
 * mirroring the migration's hard-cut "null consumed = fresh" rule (design
 * §9.1 / D4) so a legacy or corrupt row never spuriously demotes.
 */
export function parseConsumedJson(json: string | null | undefined): Record<string, string> {
  if (json === null || json === undefined || json === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Read-time freshness check (design §4.1). A run is fresh iff every upstream
 * run it consumed is still the freshest done row of that upstream within the
 * relevant iteration scope.
 *
 * @param run the node_run whose freshness we're judging
 * @param freshestDonePerUpstream map: upstreamNodeId → that upstream's freshest
 *   done top-level run in the current scope iteration (§3.2). An upstream
 *   ABSENT from the map (no done row at this scope, e.g. a settled cross-loop
 *   boundary input) is treated as still-fresh — we never demote on the basis
 *   of an upstream that has no current-scope done row (defensive).
 */
export function isNodeRunFresh(
  run: NodeRunRow,
  freshestDonePerUpstream: Map<string, NodeRunRow>,
): boolean {
  const consumed = parseConsumedJson(run.consumedUpstreamRunsJson)
  for (const [upId, consumedId] of Object.entries(consumed)) {
    const cur = freshestDonePerUpstream.get(upId)
    if (cur === undefined) continue // upstream has no current-scope done row → not stale
    if (cur.id !== consumedId) return false // upstream produced a newer done row → stale
  }
  return true
}
