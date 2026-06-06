// RFC-083 PR-F — pure blast-radius graph model. Locks node/edge derivation +
// the 2-column layout so the (heavy, xyflow) component stays a thin adapter.

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

describe('labelFromSymbolId', () => {
  test('extracts the qualifiedName segment', () => {
    expect(labelFromSymbolId('svc.ts#Svc.charge:method:2')).toBe('Svc.charge')
  })
  test('falls back to the raw id when unparseable', () => {
    expect(labelFromSymbolId('weird')).toBe('weird')
  })
})

describe('buildStructureGraph', () => {
  test('changed symbols become changed-column nodes', () => {
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
                after: node('svc.ts#Svc.charge:method:2', 'Svc.charge'),
              },
            ],
          },
        ],
        [],
      ),
    )
    expect(g.nodes).toHaveLength(1)
    expect(g.nodes[0]?.kind).toBe('changed')
    expect(g.nodes[0]?.label).toBe('Svc.charge')
    expect(g.edges).toHaveLength(0)
  })

  test('impact callers become caller nodes + caller→changed edges, laid out in 2 columns', () => {
    const changed = node('svc.ts#Svc.charge:method:2', 'Svc.charge')
    const g = buildStructureGraph(
      diffWith(
        [
          {
            filePath: 'svc.ts',
            lang: 'typescript',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [{ changeType: 'modified', kind: 'method', after: changed }],
          },
        ],
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
            ],
          },
        ],
      ),
    )
    const caller = g.nodes.find((n) => n.kind === 'caller')
    const target = g.nodes.find((n) => n.kind === 'changed')
    expect(caller?.label).toBe('Order.pay')
    expect(g.edges).toEqual([
      {
        id: 'order.ts#Order.pay:method:5->svc.ts#Svc.charge:method:2',
        source: 'order.ts#Order.pay:method:5',
        target: 'svc.ts#Svc.charge:method:2',
      },
    ])
    // callers sit left of changed symbols
    expect(caller!.x).toBeLessThan(target!.x)
  })

  test('a caller that is itself a changed symbol is not duplicated', () => {
    const a = node('a.ts#A.f:method:1', 'A.f')
    const b = node('b.ts#B.g:method:1', 'B.g')
    const g = buildStructureGraph(
      diffWith(
        [
          {
            filePath: 'a.ts',
            lang: 'typescript',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [{ changeType: 'modified', kind: 'method', after: a }],
          },
          {
            filePath: 'b.ts',
            lang: 'typescript',
            status: 'ok',
            edges: [],
            impact: [],
            changes: [{ changeType: 'modified', kind: 'method', after: b }],
          },
        ],
        // B.g (a changed symbol) calls A.f
        [
          {
            changedSymbolId: 'a.ts#A.f:method:1',
            confidence: 'extracted',
            callers: [
              {
                symbolId: 'b.ts#B.g:method:1',
                filePath: 'b.ts',
                range: { startLine: 1, endLine: 2 },
              },
            ],
          },
        ],
      ),
    )
    // 2 nodes total (both changed); no duplicate caller node for B.g
    expect(g.nodes).toHaveLength(2)
    expect(g.nodes.every((n) => n.kind === 'changed')).toBe(true)
    expect(g.edges).toHaveLength(1)
  })
})
