// RFC-083 — per-node scope ref selection (pure). "What did node N change" =
// the diff between N's pre-run snapshot and the NEXT write node's pre-run
// snapshot (or the live worktree if N is the last writer). Readonly nodes have
// no snapshot and contribute nothing.
//
// pre_snapshot is a `git stash create` sha captured before each write node
// (services/runner). Caveats surfaced to the caller: plain stash trees omit
// untracked files; after worktree-GC the snapshot objects may be pruned.

export interface NodeRunRef {
  id: string
  preSnapshot: string | null
  startedAt: number | null
}

export type NodeScopeResolution =
  | { kind: 'between'; fromRef: string; toRef: string }
  | { kind: 'to-worktree'; fromRef: string }
  | { kind: 'readonly' } // target node has no snapshot (readonly / non-write)
  | { kind: 'not-found' }

/** Resolve the (fromRef, toRef) pair for a node-scoped structural diff. */
export function resolveNodeScope(runs: NodeRunRef[], nodeRunId: string): NodeScopeResolution {
  const target = runs.find((r) => r.id === nodeRunId)
  if (target === undefined) return { kind: 'not-found' }
  if (target.preSnapshot === null || target.preSnapshot === '') return { kind: 'readonly' }

  const writes = runs
    .filter((r) => r.preSnapshot !== null && r.preSnapshot !== '')
    .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
  const idx = writes.findIndex((r) => r.id === nodeRunId)
  const next = writes[idx + 1]
  if (next !== undefined && next.preSnapshot !== null && next.preSnapshot !== '') {
    return { kind: 'between', fromRef: target.preSnapshot, toRef: next.preSnapshot }
  }
  return { kind: 'to-worktree', fromRef: target.preSnapshot }
}
