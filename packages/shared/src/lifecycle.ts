// RFC-053 PR-B P-1 — node_run.status state machine.
//
// Codifies the lifecycle of a `node_runs` row as an explicit (status, event)
// → status transition table. Every site that writes `node_runs.status` is
// supposed to go through `transitionNodeRunStatus()` (backend) or call
// `nextNodeRunStatus()` directly (pure / tests). Illegal transitions throw
// at the service layer, never reach the DB.
//
// New status or new event? Add it to the union here and the `switch` in
// `nextNodeRunStatus` will fail at compile time (`never` exhaustiveness)
// until you fill in the transition.

// ---------------------------------------------------------------------------
// Status universe — re-export from schemas/task (the DB-authoritative one).
// ---------------------------------------------------------------------------

import { NODE_RUN_STATUS, type NodeRunStatus } from './schemas/task'

/** Terminal statuses: once a row reaches one of these, no out-transition is legal. */
export const TERMINAL_NODE_RUN_STATUSES = [
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
] as const satisfies readonly NodeRunStatus[]

export function isTerminalNodeRunStatus(s: NodeRunStatus): boolean {
  return (TERMINAL_NODE_RUN_STATUSES as readonly NodeRunStatus[]).includes(s)
}

// ---------------------------------------------------------------------------
// Events: each one identifies a specific business transition.
// ---------------------------------------------------------------------------

export type NodeRunTransitionEvent =
  // runner lifecycle
  | { kind: 'mark-running' } // pending → running
  | { kind: 'mark-done' } // running → done
  | { kind: 'mark-failed'; reason?: string } // pending|running|awaiting_* → failed
  | { kind: 'mark-canceled'; reason?: string } // any non-terminal → canceled
  | { kind: 'mark-interrupted' } // any non-terminal → interrupted
  // review flow
  | { kind: 'park-review' } // pending|running → awaiting_review
  | { kind: 'approve-review' } // awaiting_review → done
  | { kind: 'iterate-review' } // awaiting_review → pending
  | { kind: 'reject-review' } // awaiting_review → pending
  // clarify flow
  | { kind: 'park-human' } // pending|running → awaiting_human
  | { kind: 'resume-clarify' } // awaiting_human → done (clarify run closes when answers land)
  // supersede / fan-out / loop
  | { kind: 'cancel-by-supersede'; reason: string } // pending|running|awaiting_* → canceled
  | { kind: 'mark-skipped'; reason?: string } // pending → skipped
  | { kind: 'mark-exhausted' } // running → exhausted

// ---------------------------------------------------------------------------
// Errors.
// ---------------------------------------------------------------------------

export class IllegalNodeRunTransition extends Error {
  readonly code = 'illegal-node-run-transition' as const
  constructor(
    readonly from: NodeRunStatus,
    readonly eventKind: NodeRunTransitionEvent['kind'],
    extra?: string,
  ) {
    super(
      `illegal node_run transition: from='${from}' via event='${eventKind}'${extra ? ` (${extra})` : ''}`,
    )
  }
}

// ---------------------------------------------------------------------------
// The transition function — single source of truth.
// ---------------------------------------------------------------------------

/**
 * Compute the next status for `cur` under event `ev`. Throws
 * IllegalNodeRunTransition if the transition is not allowed.
 *
 * All terminal `cur` values throw immediately — terminals have no
 * out-transitions. If a path needs to "rewrite" a terminal row (e.g.,
 * fixup scripts), use the lower-level `setNodeRunStatus({ allowedFrom })`
 * helper with an explicit allowlist.
 */
export function nextNodeRunStatus(cur: NodeRunStatus, ev: NodeRunTransitionEvent): NodeRunStatus {
  if (isTerminalNodeRunStatus(cur)) {
    throw new IllegalNodeRunTransition(cur, ev.kind, 'cur is terminal')
  }
  switch (ev.kind) {
    case 'mark-running':
      if (cur === 'pending') return 'running'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-done':
      if (cur === 'running') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-failed':
      if (
        cur === 'pending' ||
        cur === 'running' ||
        cur === 'awaiting_review' ||
        cur === 'awaiting_human'
      ) {
        return 'failed'
      }
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-canceled':
      // Anything non-terminal can be canceled (user-initiated abort, shutdown).
      return 'canceled'
    case 'mark-interrupted':
      // Daemon restart reaping — any non-terminal row.
      return 'interrupted'
    case 'park-review':
      if (cur === 'pending' || cur === 'running') return 'awaiting_review'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'approve-review':
      if (cur === 'awaiting_review') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'iterate-review':
    case 'reject-review':
      if (cur === 'awaiting_review') return 'pending'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'park-human':
      if (cur === 'pending' || cur === 'running') return 'awaiting_human'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'resume-clarify':
      // clarify node_run goes done when the user submits answers — the
      // SOURCE agent gets a fresh node_run separately (mint, not transition).
      if (cur === 'awaiting_human') return 'done'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'cancel-by-supersede':
      if (
        cur === 'pending' ||
        cur === 'running' ||
        cur === 'awaiting_review' ||
        cur === 'awaiting_human'
      ) {
        return 'canceled'
      }
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-skipped':
      if (cur === 'pending') return 'skipped'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    case 'mark-exhausted':
      if (cur === 'running') return 'exhausted'
      throw new IllegalNodeRunTransition(cur, ev.kind)
    default: {
      // exhaustiveness — adding a new NodeRunTransitionEvent kind without handling it
      // here is a compile error.
      const _exhaustive: never = ev
      void _exhaustive
      throw new IllegalNodeRunTransition(
        cur,
        (ev as NodeRunTransitionEvent).kind,
        'unhandled event',
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: the set of statuses from which an event is allowed.
// ---------------------------------------------------------------------------

/**
 * Returns the set of `from` statuses for which `nextNodeRunStatus(from, ev)`
 * does NOT throw. Useful for the lower-level `setNodeRunStatus()` helper and
 * for tests.
 */
export function allowedFromStatusesForEvent(ev: NodeRunTransitionEvent): readonly NodeRunStatus[] {
  const allowed: NodeRunStatus[] = []
  for (const s of NODE_RUN_STATUS) {
    if (isTerminalNodeRunStatus(s)) continue
    try {
      nextNodeRunStatus(s, ev)
      allowed.push(s)
    } catch {
      // not allowed from this status
    }
  }
  return allowed
}
