// RFC-085 T6 — turn a (fetched) forward call chain into a UML-ish sequence model:
// participants (lifelines = the classes involved) + ordered messages (each call,
// DFS pre-order = execution order, caller-class → callee-class). PURE so the
// ordering/dedup is unit-tested independent of the SVG renderer (T7).

export const UNRESOLVED_LIFELINE = '«unresolved»'

/** A node of the eagerly-fetched chain (built from CallTarget rows). */
export interface SeqCallNode {
  /** callee owner class id `${file}::${ClassQn}`, or null when unresolved. */
  ownerClass: string | null
  /** display label, e.g. `charge()`. */
  method: string
  resolution: 'resolved' | 'external' | 'unresolved'
  children: SeqCallNode[]
}

export interface SeqMessage {
  /** caller lifeline (owner-class id). */
  from: string
  /** callee lifeline (owner-class id, or UNRESOLVED_LIFELINE). */
  to: string
  label: string
  /** nesting depth (0 = direct call of the root). */
  depth: number
  resolution: 'resolved' | 'external' | 'unresolved'
}

export interface SequenceModel {
  /** lifelines in first-appearance order (root class first). */
  participants: string[]
  messages: SeqMessage[]
}

/** Leaf class name for a lifeline id (`file::a.b.C` → `C`). */
export function classDisplay(ownerClass: string): string {
  if (ownerClass === UNRESOLVED_LIFELINE) return ownerClass
  const qn = ownerClass.includes('::') ? (ownerClass.split('::')[1] ?? ownerClass) : ownerClass
  return qn.split('.').pop() ?? qn
}

/** Build the sequence model. `rootClass` is the root method's owner-class id; its
 *  direct callees are `children`. Messages are emitted DFS pre-order so they read
 *  top-to-bottom as the call executes; only resolved nodes recurse. */
export function buildSequence(rootClass: string, children: readonly SeqCallNode[]): SequenceModel {
  const participants: string[] = []
  const add = (p: string): void => {
    if (!participants.includes(p)) participants.push(p)
  }
  add(rootClass)
  const messages: SeqMessage[] = []
  const walk = (parentClass: string, nodes: readonly SeqCallNode[], depth: number): void => {
    for (const n of nodes) {
      const to = n.ownerClass ?? UNRESOLVED_LIFELINE
      add(to)
      messages.push({ from: parentClass, to, label: n.method, depth, resolution: n.resolution })
      if (n.resolution === 'resolved' && n.children.length > 0) walk(to, n.children, depth + 1)
    }
  }
  walk(rootClass, children, 0)
  return { participants, messages }
}
