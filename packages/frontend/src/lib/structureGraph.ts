// RFC-083 PR-F/PR-G — pure model for the structural-diff graph as a CLASS
// COLLABORATION DIAGRAM with a HIERARCHICAL (dagre) layout. A node is a CARD (a
// class / file) listing its changed members + the members that call changed code
// elsewhere. EDGES are the real relationships among changed classes:
//   - 'inherits'   : extends / implements           (from backend classEdges)
//   - 'references' : constructs / holds / uses       (from backend classEdges)
//   - 'calls'      : a method calls a changed method (from impact)
// dagre ranks the cards top→down by these edges so the architecture/hierarchy
// reads at a glance. All logic here so the xyflow component stays a thin adapter.

import dagre from '@dagrejs/dagre'
import type { StructuralDiff, SymbolKind, ChangeType } from '@agent-workflow/shared'

const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'trait',
  'struct',
  'enum',
  'object',
  'namespace',
  'module',
])
const MEMBER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'method',
  'function',
  'constructor',
  'field',
  'property',
  'constant',
])

export type MemberRole = 'changed' | 'caller'
export type EdgeKind = 'inherits' | 'references' | 'calls'

export interface GraphMember {
  id: string
  label: string
  kind: SymbolKind
  changeType?: ChangeType
  role: MemberRole
}
export type CardKind = SymbolKind | 'file'
export interface GraphCard {
  id: string
  title: string
  file: string
  kind: CardKind
  changeType?: ChangeType
  isChanged: boolean
  members: GraphMember[]
  x: number
  y: number
  w: number
  h: number
}
export interface GraphCardEdge {
  id: string
  source: string
  target: string
  kind: EdgeKind
}
export interface StructureGraph {
  cards: GraphCard[]
  edges: GraphCardEdge[]
}

const CARD_W = 240
const HEADER_H = 34
const ROW_H = 22
const PAD_V = 12
const EDGE_RANK: Record<EdgeKind, number> = { inherits: 3, references: 2, calls: 1 }

export function fileBase(p: string): string {
  return p.split('/').pop() ?? p
}
function qnFromId(id: string): string {
  const afterHash = id.split('#')[1]
  if (afterHash === undefined) return id
  return afterHash.split(':')[0] ?? id
}
function fileFromId(id: string): string {
  return id.split('#')[0] ?? id
}
function leafOf(qualifiedName: string): string {
  const idx = qualifiedName.lastIndexOf('.')
  return idx >= 0 ? qualifiedName.slice(idx + 1) : qualifiedName
}
function memberContainer(
  filePath: string,
  qualifiedName: string,
): { key: string; title: string; kind: CardKind } {
  const idx = qualifiedName.lastIndexOf('.')
  if (idx > 0) {
    const container = qualifiedName.slice(0, idx)
    return { key: `${filePath}::${container}`, title: container, kind: 'class' }
  }
  return { key: `${filePath}::<file>`, title: fileBase(filePath), kind: 'file' }
}

function cardHeight(memberCount: number): number {
  return HEADER_H + memberCount * ROW_H + PAD_V
}

/** Hierarchical top→down layout via dagre. Mutates each card's x/y/w/h. */
function layoutWithDagre(cards: GraphCard[], edges: GraphCardEdge[]): void {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 36, ranksep: 56, marginx: 16, marginy: 16 })
  g.setDefaultEdgeLabel(() => ({}))
  for (const c of cards) {
    c.w = CARD_W
    c.h = cardHeight(c.members.length)
    g.setNode(c.id, { width: c.w, height: c.h })
  }
  for (const e of edges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  for (const c of cards) {
    const n = g.node(c.id)
    // dagre gives the node CENTER; xyflow positions are top-left.
    c.x = n.x - c.w / 2
    c.y = n.y - c.h / 2
  }
}

export function buildStructureGraph(diff: StructuralDiff): StructureGraph {
  const cards = new Map<string, GraphCard>()
  const ensureCard = (key: string, title: string, file: string, kind: CardKind): GraphCard => {
    let c = cards.get(key)
    if (c === undefined) {
      c = { id: key, title, file, kind, isChanged: false, members: [], x: 0, y: 0, w: 0, h: 0 }
      cards.set(key, c)
    }
    return c
  }

  // 1) changed symbols → cards + changed member rows.
  const changedSymbolCard = new Map<string, string>()
  for (const f of diff.files) {
    for (const ch of f.changes) {
      const sym = ch.after ?? ch.before
      if (sym === undefined) continue
      if (CONTAINER_KINDS.has(sym.kind)) {
        const card = ensureCard(
          `${sym.filePath}::${sym.qualifiedName}`,
          sym.qualifiedName,
          sym.filePath,
          sym.kind,
        )
        card.changeType = ch.changeType
        card.isChanged = true
        changedSymbolCard.set(sym.id, card.id)
      } else if (MEMBER_KINDS.has(sym.kind)) {
        const c = memberContainer(sym.filePath, sym.qualifiedName)
        const card = ensureCard(c.key, c.title, sym.filePath, c.kind)
        card.isChanged = true
        card.members.push({
          id: sym.id,
          label: sym.name,
          kind: sym.kind,
          changeType: ch.changeType,
          role: 'changed',
        })
        changedSymbolCard.set(sym.id, card.id)
      }
    }
  }

  // 2) edges. Prefer inherits > references > calls for a given pair.
  const edgeMap = new Map<string, GraphCardEdge>()
  const addEdge = (source: string, target: string, kind: EdgeKind): void => {
    if (source === target || !cards.has(source) || !cards.has(target)) return
    const id = `${source}=>${target}`
    const existing = edgeMap.get(id)
    if (existing === undefined || EDGE_RANK[kind] > EDGE_RANK[existing.kind]) {
      edgeMap.set(id, { id, source, target, kind })
    }
  }
  // class-level relationships (the architecture); guard for older API responses
  for (const e of diff.classEdges ?? []) addEdge(e.from, e.to, e.kind)
  // method-level call edges + caller cards (from impact)
  for (const item of diff.impact) {
    const targetCardId = changedSymbolCard.get(item.changedSymbolId)
    if (targetCardId === undefined) continue
    for (const caller of item.callers) {
      let callerKey: string
      let callerTitle: string
      let callerFile: string
      let callerKind: CardKind
      let callerLabel: string | null
      if (caller.symbolId !== undefined) {
        const file = fileFromId(caller.symbolId)
        const qn = qnFromId(caller.symbolId)
        const c = memberContainer(file, qn)
        callerKey = c.key
        callerTitle = c.title
        callerFile = file
        callerKind = c.kind
        callerLabel = leafOf(qn)
      } else {
        callerKey = `${caller.filePath}::<file>`
        callerTitle = fileBase(caller.filePath)
        callerFile = caller.filePath
        callerKind = 'file'
        callerLabel = null
      }
      if (callerKey === targetCardId) continue
      const callerCard = ensureCard(callerKey, callerTitle, callerFile, callerKind)
      if (callerLabel !== null && !callerCard.members.some((m) => m.label === callerLabel)) {
        callerCard.members.push({
          id: `${callerKey}::${callerLabel}`,
          label: callerLabel,
          kind: 'method',
          role: 'caller',
        })
      }
      addEdge(callerKey, targetCardId, 'calls')
    }
  }

  const list = [...cards.values()]
  const edges = [...edgeMap.values()]
  layoutWithDagre(list, edges)
  return { cards: list, edges }
}
