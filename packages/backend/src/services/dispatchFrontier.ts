// RFC-076 PR-A — trim-B dispatch predicates (PURE, currently UNWIRED).
//
// These are the two NOVEL predicates the trim-B dispatch frontier needs, on top
// of fix A's computeReadyNodes / areTransitiveUpstreamsCompleted (freshness.ts).
// They are the much-reviewed (3 adversarial rounds) corrections to the original
// full-B sketch:
//
//   - isDispatchable(latestRow, kind, …) — the per-node status gate. The crux
//     (round-2 N1): `failed`/`interrupted` MUST be dispatchable — they are the
//     resume / retry / daemon-restart re-mint signal (resumeTask leaves the
//     failed row and lets the scheduler mint retry_index=max+1; reapOrphanRuns
//     flips running→interrupted). Excluding them — as full-B did — would turn
//     every resume into "scheduler stalled". `exhausted` (loop-max, a true
//     terminal, round-3 HIGH-2) and leaf `awaiting_*` (round-1 C2) are NOT
//     dispatchable; a WRAPPER's `awaiting_*` IS (round-2 N2 resume anchor), but
//     only when its inner scope has fresh post-answer work.
//
//   - wrapperHasFreshInnerWork(wrapperRow, rows, definition) — round-3 HIGH-1.
//     A wrapper-loop parks its OWN top-level row at `parentIteration`, but its
//     inner descendants (and the clarify/review rerun minted on answer) live at
//     the loop counter `i`. Scanning the wrapper's own iteration would miss the
//     i≥1 rerun → the answered task would re-park forever ("scheduler stalled").
//     So the scan window comes from the wrapper PROGRESS payload's iteration for
//     loops, and from the wrapper row's own iteration for git wrappers (git
//     inner shares the wrapper iteration).
//
// PURE module: only types + isNodeRunFresh (freshness.ts) + decodeWrapperProgress
// (wrapperProgress.ts, itself pure). No DB / scheduler import. The frontier
// ORCHESTRATION (read rows → latestPerNode → freshestDone → completed → ready)
// and the runScope wiring are PR-B (deferred) — they belong with the scheduler's
// row-ordering primitives (isFresherNodeRun / buildFreshestDonePerNode).

import type { NodeKind, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import type { nodeRuns } from '../db/schema'
import { isNodeRunFresh } from './freshness'
import { decodeWrapperProgress } from './wrapperProgress'

type NodeRunRow = typeof nodeRuns.$inferSelect

const WRAPPER_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'wrapper-loop',
  'wrapper-git',
  'wrapper-fanout',
])

/** Safe read of a wrapper node's inner `nodeIds` (absent / non-array → []). */
function innerNodeIdsOf(node: WorkflowNode | undefined): string[] {
  const raw = (node as { nodeIds?: unknown } | undefined)?.nodeIds
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string')
}

/**
 * All transitive inner-descendant node ids of a wrapper (direct inner +
 * recursively the inner of any nested wrapper). Cycle-safe via `visiting`
 * (definitions are acyclic containment trees, but guard defensively). G6.
 */
export function wrapperInnerDescendants(
  wrapperNodeId: string,
  definition: WorkflowDefinition,
  acc: Set<string> = new Set(),
  visiting: Set<string> = new Set(),
): Set<string> {
  if (visiting.has(wrapperNodeId)) return acc
  visiting.add(wrapperNodeId)
  const node = definition.nodes.find((n) => n.id === wrapperNodeId)
  for (const id of innerNodeIdsOf(node)) {
    acc.add(id)
    wrapperInnerDescendants(id, definition, acc, visiting)
  }
  return acc
}

/**
 * RFC-076 round-3 HIGH-1. Does a parked wrapper's inner scope hold fresh
 * post-answer work (a `pending` row minted by submitClarifyAnswers /
 * submitReviewDecision while the wrapper was suspended)? Scans inner-descendant
 * rows AT THE CORRECT ITERATION WINDOW:
 *   - wrapper-loop: the loop counter from the wrapper's progress payload (the
 *     iteration the inner scope parked on). Malformed/absent → 0 (mirrors the
 *     runtime resume fallback `startIter=0`). NOT the wrapper row's own
 *     iteration (which is the parent scope's iteration — would miss i≥1 work).
 *   - wrapper-git: the wrapper row's own iteration (git inner shares it).
 */
export function wrapperHasFreshInnerWork(
  wrapperRow: NodeRunRow,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): boolean {
  const node = definition.nodes.find((n) => n.id === wrapperRow.nodeId)
  const kind = node?.kind
  let innerIter: number
  if (kind === 'wrapper-loop') {
    const progress = decodeWrapperProgress(wrapperRow.wrapperProgressJson, () => {})
    innerIter = progress?.iteration ?? 0
  } else {
    // wrapper-git (and any non-loop wrapper): inner shares the wrapper iteration.
    innerIter = wrapperRow.iteration
  }
  const inner = wrapperInnerDescendants(wrapperRow.nodeId, definition)
  return rows.some(
    (r) => inner.has(r.nodeId) && r.iteration === innerIter && r.status === 'pending',
  )
}

/**
 * RFC-076 trim-B per-node dispatch gate. Given a node's LATEST top-level run
 * row (or undefined if it never ran), its workflow kind, the current
 * freshest-done map, and the full row set + definition (for the wrapper
 * carve-out), decide whether the node may be (re-)dispatched.
 *
 *   undefined            → true   (never ran)
 *   pending              → true   (out-of-band mint / placeholder)
 *   done ∧ !fresh        → true   (stale-done re-run; fix A multi-hop demote)
 *   failed | interrupted → true   (resume / retry re-mint signal — N1; the
 *                                  scheduler mints retry_index=max+1, bounded by
 *                                  runOneNode's attempt ≤ retryIndex+maxRetries)
 *   wrapper awaiting_*   → wrapperHasFreshInnerWork (N2 resume anchor + HIGH-1)
 *   else                 → false  (done∧fresh / leaf awaiting_* [C2] /
 *                                  exhausted [loop-max true terminal, HIGH-2] /
 *                                  canceled / running)
 *
 * In-pass busy-loop protection does NOT come from this gate — it comes from the
 * scheduler's per-invocation `dispatchedThisInvocation` set (N3) + runOneNode
 * minting a `pending` row on dispatch. This gate only decides eligibility.
 */
export function isDispatchable(
  row: NodeRunRow | undefined,
  kind: NodeKind,
  freshestDonePerUpstream: Map<string, NodeRunRow>,
  rows: readonly NodeRunRow[],
  definition: WorkflowDefinition,
): boolean {
  if (row === undefined) return true
  if (row.status === 'pending') return true
  if (row.status === 'done') return !isNodeRunFresh(row, freshestDonePerUpstream)
  if (row.status === 'failed' || row.status === 'interrupted') return true
  if (row.status === 'awaiting_human' || row.status === 'awaiting_review') {
    if (WRAPPER_KINDS.has(kind)) return wrapperHasFreshInnerWork(row, rows, definition)
    return false // leaf parked — never re-dispatch (C2)
  }
  // exhausted (loop-max true terminal) / canceled / running → not dispatchable
  return false
}
