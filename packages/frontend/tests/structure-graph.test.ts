// RFC-083 PR-F — pure blast-radius graph model. BANDED: one band per changed
// method that has callers (method right, callers stacked left, edges caller →
// method). Changed units with NO callers still appear (standalone grid) so the
// graph is never blank when there are real changes — only non-graphable kinds
// (fields/imports) yield an empty graph. Locks that semantic + the layout.

import { describe, expect, test } from 'vitest'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'
import { buildStructureGraph, labelFromSymbolId } from '../src/lib/structureGraph'

function node(id: string, qn: string): SymbolNode {
  return {
    id,
    kind: 'method',
    name: qn.split('.').pop() ?? qn,
    qualifiedName: qn,
    lang: 'typescript',
    filePath: id.split('#')[0] ?? 'f',
    confidence: 'extracted',
  }
}

function diffWith(
  files: StructuralDiff['files'],
  impact: StructuralDiff['impact'],
): StructuralDiff {
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'deep',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact,
    summary: computeSummary(files, []),
  }
}

const svc = node('svc.ts#Svc.charge:method:2', 'Svc.charge')
const fileWith = (...syms: SymbolNode[]): StructuralDiff['files'][number] => ({
  filePath: syms[0]?.filePath ?? 'f',
  lang: 'typescript',
  status: 'ok',
  edges: [],
  impact: [],
  changes: syms.map((s) => ({ changeType: 'modified', kind: 'method', after: s })),
})

describe('labelFromSymbolId', () => {
  test('extracts the qualifiedName segment', () => {
    expect(labelFromSymbolId('svc.ts#Svc.charge:method:2')).toBe('Svc.charge')
  })
  test('falls back to the raw id when unparseable', () => {
    expect(labelFromSymbolId('weird')).toBe('weird')
  })
})

describe('buildStructureGraph', () => {
  test('changed methods with NO callers still appear (standalone, no edges)', () => {
    const g = buildStructureGraph(diffWith([fileWith(svc)], []))
    expect(g.nodes).toHaveLength(1) // the changed method is shown
    expect(g.nodes[0]?.kind).toBe('changed')
    expect(g.nodes[0]?.label).toBe('Svc.charge')
    expect(g.edges).toEqual([]) // no callers → no edges
  })

  test('changed nodes carry their changeType (added / modified / removed)', () => {
    const added = node('a.ts#A.n:method:1', 'A.n')
    const removed = node('a.ts#A.o:method:2', 'A.o')
    const files: StructuralDiff['files'] = [
      {
        filePath: 'a.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'method', after: added },
          { changeType: 'removed', kind: 'method', before: removed },
        ],
      },
    ]
    const g = buildStructureGraph(diffWith(files, []))
    const byLabel = new Map(g.nodes.map((n) => [n.label, n.changeType]))
    expect(byLabel.get('A.n')).toBe('added')
    expect(byLabel.get('A.o')).toBe('removed')
  })

  test('non-graphable kinds (field/import) produce no nodes → empty graph', () => {
    const field: SymbolNode = {
      ...svc,
      id: 'm.py#C.x:field:1',
      kind: 'field',
      qualifiedName: 'C.x',
    }
    const g = buildStructureGraph(diffWith([fileWith(field)], []))
    expect(g.nodes).toEqual([])
  })

  test('a band: changed method (right) + its callers (left), edges caller → method', () => {
    const g = buildStructureGraph(
      diffWith(
        [fileWith(svc)],
        [
          {
            changedSymbolId: 'svc.ts#Svc.charge:method:2',
            confidence: 'extracted',
            callers: [
              {
                symbolId: 'order.ts#Order.pay:method:5',
                filePath: 'order.ts',
                range: { startLine: 5, endLine: 6 },
              },
              {
                symbolId: 'cart.ts#Cart.total:method:9',
                filePath: 'cart.ts',
                range: { startLine: 9, endLine: 10 },
              },
            ],
          },
        ],
      ),
    )
    const target = g.nodes.find((n) => n.kind === 'changed')
    const callers = g.nodes.filter((n) => n.kind === 'caller')
    expect(target?.label).toBe('Svc.charge')
    expect(callers.map((c) => c.label).sort()).toEqual(['Cart.total', 'Order.pay'])
    // callers sit left of the changed method
    for (const c of callers) expect(c.x).toBeLessThan(target!.x)
    // every edge points caller → the changed method
    expect(g.edges).toHaveLength(2)
    for (const e of g.edges) expect(e.target).toBe('svc.ts#Svc.charge:method:2')
  })

  test('deep callers with no symbolId get a synthetic file:line node', () => {
    const g = buildStructureGraph(
      diffWith(
        [fileWith(svc)],
        [
          {
            changedSymbolId: 'svc.ts#Svc.charge:method:2',
            confidence: 'extracted',
            callers: [{ filePath: 'order.ts', range: { startLine: 7, endLine: 7 } }],
          },
        ],
      ),
    )
    const caller = g.nodes.find((n) => n.kind === 'caller')
    expect(caller?.label).toBe('order.ts') // falls back to the file path
    expect(g.edges[0]?.source).toContain('order.ts:7')
  })

  test('multiple targets → stacked bands (later band sits lower)', () => {
    const a = node('a.ts#A.f:method:1', 'A.f')
    const b = node('b.ts#B.g:method:1', 'B.g')
    const g = buildStructureGraph(
      diffWith(
        [fileWith(a), fileWith(b)],
        [
          {
            changedSymbolId: 'a.ts#A.f:method:1',
            confidence: 'extracted',
            callers: [
              { symbolId: 'x#X.m:method:1', filePath: 'x.ts', range: { startLine: 1, endLine: 2 } },
            ],
          },
          {
            changedSymbolId: 'b.ts#B.g:method:1',
            confidence: 'extracted',
            callers: [
              { symbolId: 'y#Y.m:method:1', filePath: 'y.ts', range: { startLine: 1, endLine: 2 } },
            ],
          },
        ],
      ),
    )
    const targets = g.nodes.filter((n) => n.kind === 'changed')
    expect(targets).toHaveLength(2)
    expect(targets[0]!.y).toBeLessThan(targets[1]!.y) // second band below the first
  })
})
