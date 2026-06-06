// RFC-085 — call-chain view model (pure). The chain is fetched LAZILY one level
// at a time (GET /call-targets per method); this module holds the small decision
// helpers — whether a node can expand, given cycle + depth guards — so they get
// unit coverage independent of the React tree.

import type { CallTarget } from '@agent-workflow/shared'

export type { CallTarget }

/** Max chain depth (root = 0); deeper expands are blocked + marked truncated so a
 *  pathological recursion can't open an unbounded tree. */
export const MAX_CHAIN_DEPTH = 12

export type ExpandState =
  | 'expandable' // resolved, not on the path, within depth — has a ▸
  | 'cycle' // its ref is already an ancestor — stop (would recurse forever)
  | 'too-deep' // depth cap reached — stop
  | 'leaf' // external/unresolved (no ref) — nothing to expand

/** Whether a target can be expanded into its own callees. `ancestorRefs` is the
 *  set of method refs from the root down to (and excluding) this node. */
export function expandState(
  target: Pick<CallTarget, 'ref' | 'resolution'>,
  ancestorRefs: ReadonlySet<string>,
  depth: number,
): ExpandState {
  if (target.ref === undefined || target.resolution !== 'resolved') return 'leaf'
  if (ancestorRefs.has(target.ref)) return 'cycle'
  if (depth >= MAX_CHAIN_DEPTH) return 'too-deep'
  return 'expandable'
}

/** The readable method name from a call ref (`file#Qualified.name`). */
export function refLabel(ref: string): string {
  const qn = ref.includes('#') ? (ref.split('#')[1] ?? ref) : ref
  const leaf = qn.split('.').pop() ?? qn
  return `${leaf}()`
}
