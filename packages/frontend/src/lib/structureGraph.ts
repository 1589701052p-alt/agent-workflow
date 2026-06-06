// RFC-083 PR-F — pure model for the read-only blast-radius graph. The graph
// answers ONE question: "for each changed method, who calls it (and is therefore
// affected)?". So it's laid out as horizontal BANDS — one per changed symbol
// that has callers — with the changed symbol on the right and its callers
// stacked directly to its left. Reading top-to-bottom you get, per band:
// "<changed symbol> ← <caller>, <caller>, …". Changed symbols with no callers
// carry no cross-symbol impact and are omitted (they're still in the tree view).
// Manual layout (no dagre/elk dep); edges point caller → changed (call
// direction). All logic here so the xyflow component stays a thin adapter.

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

const COL_CALLER_X = 0
const COL_CHANGED_X = 320
const ROW_H = 60 // vertical pitch between stacked callers
const NODE_H = 40 // approx node height (for centering the target in its band)
const BAND_GAP = 28 // blank space between bands
const Y0 = 8

/** `${filePath}#${qualifiedName}:${kind}:${line}` → qualifiedName (fallback id). */
export function labelFromSymbolId(id: string): string {
  const afterHash = id.split('#')[1]
  if (afterHash === undefined) return id
  return afterHash.split(':')[0] ?? id
}

export function buildStructureGraph(diff: StructuralDiff): StructureGraph {
  // qualifiedName for each changed symbol (nicer label than parsing the id).
  const changedLabel = new Map<string, string>()
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym !== undefined) changedLabel.set(sym.id, sym.qualifiedName)
    }
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  let y = Y0

  for (const item of diff.impact) {
    if (item.callers.length === 0) continue // no blast radius → not in the graph
    const targetLabel =
      changedLabel.get(item.changedSymbolId) ?? labelFromSymbolId(item.changedSymbolId)
    const bandHeight = item.callers.length * ROW_H
    // Center the changed symbol vertically within its band of callers.
    const targetY = y + Math.max(0, (bandHeight - NODE_H) / 2)
    nodes.push({
      id: item.changedSymbolId,
      label: targetLabel,
      kind: 'changed',
      x: COL_CHANGED_X,
      y: targetY,
    })

    item.callers.forEach((c, i) => {
      const baseId = c.symbolId ?? `${c.filePath}:${c.range.startLine}`
      // Scope the caller node to THIS band so a caller of two changed symbols
      // appears in each band (self-contained, readable clusters).
      const callerNodeId = `${item.changedSymbolId}::${baseId}`
      const callerLabel = c.symbolId !== undefined ? labelFromSymbolId(c.symbolId) : c.filePath
      nodes.push({
        id: callerNodeId,
        label: callerLabel,
        kind: 'caller',
        x: COL_CALLER_X,
        y: y + i * ROW_H,
      })
      edges.push({ id: callerNodeId, source: callerNodeId, target: item.changedSymbolId })
    })

    y += bandHeight + BAND_GAP
  }

  return { nodes, edges }
}
