// RFC-058 — GENERAL clarify-history aging cutoff. Shared pure helper that
// both self-clarify and cross-clarify (designer / questioner sides) call to
// drop Q&A rounds whose iteration is below the cutoff returned by
// `computeHistoryCutoff` (backend-only, DB access required so it lives in
// the backend service module).
//
// Single source of truth means the GENERAL rule scheduler.ts:1347 calls out
// can never again be wired on only one path; the historical RFC-056 缺口 1
// (questioner aging gap) and 缺口 2 (wrapper-loop loop_iter isolation) both
// originate from forgetting to thread the cutoff / loop_iter filter into one
// of the two parallel functions.

/** Generic row shape acceptable to `applyAgingCutoff`. Both `clarify_rounds`
 *  query results (DB rows) and the in-memory schema-typed objects expose
 *  `iteration`. */
export interface ClarifyRoundForAging {
  iteration: number
}

/**
 * Filter clarify rounds by an aging cutoff. `undefined` cutoff is a no-op
 * (returns a shallow copy — caller-mutation safe). Otherwise drops rows whose
 * `iteration < cutoff`.
 *
 * The cutoff itself is computed backend-side from the latest prior done
 * top-level node_run for (taskId, nodeId, shardKey) that has at least one
 * `node_run_outputs` row — i.e. the run whose output is already baked into
 * the prompt's `<workflow-output>` history. Anything older than that round
 * is folded into that output and re-feeding it on a later rerun would waste
 * tokens + re-anchor the agent to resolved decisions.
 */
export function applyAgingCutoff<T extends ClarifyRoundForAging>(
  rows: ReadonlyArray<T>,
  cutoff: number | undefined,
): T[] {
  if (cutoff === undefined) return rows.slice()
  return rows.filter((r) => r.iteration >= cutoff)
}
