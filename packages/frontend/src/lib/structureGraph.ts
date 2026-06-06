// RFC-083 PR-F — pure model for the read-only blast-radius graph.
//
// The graph shows every changed code unit (class/method/function/…). Where a
// changed method HAS callers it's drawn as a BAND — the method on the right with
// its callers stacked to its left, arrows caller → method ("who is affected").
// Changed units with no detected callers are still shown, as a standalone grid
// below the bands (so the graph is never blank just because nothing calls them).
// Read a band top-to-bottom: "<changed method> ← <caller>, <caller>, …".
// Manual layout (no dagre/elk dep); logic here so the xyflow component stays thin.

import type { StructuralDiff, SymbolKind } from '@agent-workflow/shared'

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

// Kinds worth a node — the structural units. Fields/imports/constants are noise.
const GRAPH_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'function',
  'method',
  'constructor',
])

const COL_CALLER_X = 0
const COL_CHANGED_X = 320
const ROW_H = 60 // vertical pitch between stacked callers / grid rows
const NODE_H = 40 // approx node height (for centering the target in its band)
const BAND_GAP = 28 // blank space between bands
const GRID_COLS = 3
const GRID_W = 210
const Y0 = 8

/** `${filePath}#${qualifiedName}:${kind}:${line}` → qualifiedName (fallback id). */
export function labelFromSymbolId(id: string): string {
  const afterHash = id.split('#')[1]
  if (afterHash === undefined) return id
  return afterHash.split(':')[0] ?? id
}

export function buildStructureGraph(diff: StructuralDiff): StructureGraph {
  // every changed symbol: id → {label, kind}.
  const changed = new Map<string, { label: string; kind: SymbolKind }>()
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym !== undefined) changed.set(sym.id, { label: sym.qualifiedName, kind: sym.kind })
    }
  }

  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const banded = new Set<string>()
  let y = Y0

  // 1) bands — changed methods that have callers.
  for (const item of diff.impact) {
    if (item.callers.length === 0) continue
    banded.add(item.changedSymbolId)
    const targetLabel =
      changed.get(item.changedSymbolId)?.label ?? labelFromSymbolId(item.changedSymbolId)
    const bandHeight = item.callers.length * ROW_H
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

  // 2) standalone — changed units with no callers, in a grid below the bands.
  const standalone = [...changed.entries()].filter(
    ([id, v]) => !banded.has(id) && GRAPH_KINDS.has(v.kind),
  )
  const gridY0 = nodes.length > 0 ? y + BAND_GAP : Y0
  standalone.forEach(([id, v], idx) => {
    const col = idx % GRID_COLS
    const row = Math.floor(idx / GRID_COLS)
    nodes.push({ id, label: v.label, kind: 'changed', x: col * GRID_W, y: gridY0 + row * ROW_H })
  })

  return { nodes, edges }
}
