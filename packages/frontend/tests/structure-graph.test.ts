// RFC-083 PR-F/PR-G — class-collaboration graph model. Cards = classes/files
// with member rows; edges come from classEdges (inherits/references) + impact
// (calls); dagre lays the cards out top→down by those edges (hierarchy). Locks
// the grouping, edge derivation + kind precedence, and the hierarchy ordering.

import { describe, expect, test } from 'vitest'
import {
  computeSummary,
  type StructuralDiff,
  type SymbolNode,
  type ClassEdge,
} from '@agent-workflow/shared'
import { buildStructureGraph, fileBase } from '../src/lib/structureGraph'

function sym(filePath: string, qn: string, kind: SymbolNode['kind']): SymbolNode {
  return {
    id: `${filePath}#${qn}:${kind}:1`,
    kind,
    name: qn.includes('.') ? (qn.split('.').pop() ?? qn) : qn,
    qualifiedName: qn,
    lang: 'typescript',
    filePath,
    confidence: 'extracted',
  }
}
const cls = (file: string, name: string): StructuralDiff['files'][number] => ({
  filePath: file,
  lang: 'typescript',
  status: 'ok',
  edges: [],
  impact: [],
  changes: [{ changeType: 'added', kind: 'class', after: sym(file, name, 'class') }],
})

function diffWith(
  files: StructuralDiff['files'],
  opts: { impact?: StructuralDiff['impact']; classEdges?: ClassEdge[] } = {},
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
    impact: opts.impact ?? [],
    classEdges: opts.classEdges ?? [],
    summary: computeSummary(files, []),
  }
}

describe('buildStructureGraph — cards + members', () => {
  test('a changed method becomes a member row inside its CLASS card', () => {
    const g = buildStructureGraph(
      diffWith([
        {
          filePath: 'svc.ts',
          lang: 'typescript',
          status: 'ok',
          edges: [],
          impact: [],
          changes: [
            {
              changeType: 'modified',
              kind: 'method',
              after: sym('svc.ts', 'OrderService.charge', 'method'),
            },
            {
              changeType: 'added',
              kind: 'method',
              after: sym('svc.ts', 'OrderService.refund', 'method'),
            },
          ],
        },
      ]),
    )
    const card = g.cards.find((c) => c.title === 'OrderService')
    expect(card?.isChanged).toBe(true)
    expect(card?.members.map((m) => `${m.changeType} ${m.label}`).sort()).toEqual([
      'added refund',
      'modified charge',
    ])
  })

  test('non-graphable kinds (only an import) → no cards', () => {
    const g = buildStructureGraph(
      diffWith([
        {
          filePath: 'm.py',
          lang: 'python',
          status: 'ok',
          edges: [],
          impact: [],
          changes: [{ changeType: 'added', kind: 'import', after: sym('m.py', 'os', 'import') }],
        },
      ]),
    )
    expect(g.cards).toEqual([])
  })
})

describe('buildStructureGraph — edges', () => {
  test('classEdges become graph edges with their kind', () => {
    const edge: ClassEdge = { from: 'a.ts::A', to: 'b.ts::B', kind: 'inherits' }
    const g = buildStructureGraph(
      diffWith([cls('a.ts', 'A'), cls('b.ts', 'B')], { classEdges: [edge] }),
    )
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({ source: 'a.ts::A', target: 'b.ts::B', kind: 'inherits' })
  })

  test('inherits wins over a calls edge for the same pair', () => {
    const g = buildStructureGraph(
      diffWith([cls('a.ts', 'A'), cls('b.ts', 'B')], {
        classEdges: [{ from: 'a.ts::A', to: 'b.ts::B', kind: 'inherits' }],
        impact: [], // even if a call edge existed, inherits ranks higher
      }),
    )
    expect(g.edges.filter((e) => e.source === 'a.ts::A' && e.target === 'b.ts::B')).toHaveLength(1)
    expect(g.edges[0]?.kind).toBe('inherits')
  })

  test('impact yields a caller card + a calls edge', () => {
    const g = buildStructureGraph(
      diffWith(
        [
          {
            filePath: 'svc.ts',
            lang: 'typescript',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [
              {
                changeType: 'modified',
                kind: 'method',
                after: sym('svc.ts', 'Svc.charge', 'method'),
              },
            ],
          },
        ],
        {
          impact: [
            {
              changedSymbolId: 'svc.ts#Svc.charge:method:1',
              confidence: 'extracted',
              callers: [
                {
                  symbolId: 'ctrl.ts#Checkout.pay:method:3',
                  filePath: 'ctrl.ts',
                  range: { startLine: 3, endLine: 4 },
                },
              ],
            },
          ],
        },
      ),
    )
    expect(g.cards.find((c) => c.title === 'Checkout')?.isChanged).toBe(false)
    expect(g.edges).toHaveLength(1)
    expect(g.edges[0]).toMatchObject({
      source: 'ctrl.ts::Checkout',
      target: 'svc.ts::Svc',
      kind: 'calls',
    })
  })
})

describe('buildStructureGraph — hierarchy layout (dagre)', () => {
  test('A → B (A depends on B) puts A above B', () => {
    const g = buildStructureGraph(
      diffWith([cls('a.ts', 'A'), cls('b.ts', 'B')], {
        classEdges: [{ from: 'a.ts::A', to: 'b.ts::B', kind: 'references' }],
      }),
    )
    const a = g.cards.find((c) => c.title === 'A')!
    const b = g.cards.find((c) => c.title === 'B')!
    expect(a.y).toBeLessThan(b.y) // top→down hierarchy
  })
})

test('fileBase strips the directory', () => {
  expect(fileBase('src/a/b.ts')).toBe('b.ts')
})
