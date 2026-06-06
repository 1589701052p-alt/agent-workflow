// RFC-083 PR-F — pure model for the read-only blast-radius graph: changed
// symbols (right column) and who calls them (left column), with manual layout
// (no dagre/elk dependency). Edges point caller → changed symbol. The component
// just renders this; all logic is here so it stays unit-testable.

import type { StructuralDiff } from '@agent-workflow/shared'

export interface GraphNode {
  id: string
  label: string
  kind: 'changed' | 'caller'
  x: number
  y: number
}
export interface GraphEdge {
  id: string
  source: string
  target: string
}
export interface StructureGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

const COL_CHANGED_X = 360
const COL_CALLER_X = 0
const ROW_H = 64
const ROW_Y0 = 8

/** `${filePath}#${qualifiedName}:${kind}:${line}` → qualifiedName (fallback id). */
export function labelFromSymbolId(id: string): string {
  const afterHash = id.split('#')[1]
  if (afterHash === undefined) return id
  return afterHash.split(':')[0] ?? id
}

export function buildStructureGraph(diff: StructuralDiff): StructureGraph {
  const changed = new Map<string, string>() // id → label
  const callers = new Map<string, string>() // id → label (callers not already changed)

  // Every changed symbol is a node (so changes with no callers still appear).
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym === undefined) continue
      changed.set(sym.id, sym.qualifiedName)
    }
  }

  const edgeKeys = new Set<string>()
  const edges: GraphEdge[] = []
  for (const item of diff.impact) {
    if (!changed.has(item.changedSymbolId)) {
      changed.set(item.changedSymbolId, labelFromSymbolId(item.changedSymbolId))
    }
    for (const caller of item.callers) {
      // Deep (SCIP) callers carry no symbolId — synthesize one from file:line.
      const callerId = caller.symbolId ?? `${caller.filePath}:${caller.range.startLine}`
      const callerLabel =
        caller.symbolId !== undefined ? labelFromSymbolId(caller.symbolId) : caller.filePath
      // a caller that is itself a changed symbol stays in the changed column
      if (!changed.has(callerId)) {
        callers.set(callerId, callerLabel)
      }
      const key = `${callerId}->${item.changedSymbolId}`
      if (edgeKeys.has(key)) continue
      edgeKeys.add(key)
      edges.push({ id: key, source: callerId, target: item.changedSymbolId })
    }
  }

  const nodes: GraphNode[] = []
  let i = 0
  for (const [id, label] of changed) {
    nodes.push({ id, label, kind: 'changed', x: COL_CHANGED_X, y: ROW_Y0 + i * ROW_H })
    i += 1
  }
  let j = 0
  for (const [id, label] of callers) {
    nodes.push({ id, label, kind: 'caller', x: COL_CALLER_X, y: ROW_Y0 + j * ROW_H })
    j += 1
  }
  return { nodes, edges }
}
