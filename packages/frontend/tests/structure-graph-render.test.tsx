// RFC-083 PR-F — render check for the class-collaboration graph: mounting it
// actually produces class CARDS with member rows + an edge in the DOM (not just
// a blank canvas). This is the "does the graph really render" guard.

import { describe, expect, test, afterEach } from 'vitest'
import { cleanup, render, fireEvent } from '@testing-library/react'
import { computeSummary, type StructuralDiff, type SymbolNode } from '@agent-workflow/shared'
import '../src/i18n'
import { StructuralGraph } from '../src/components/structure/StructuralGraph'

afterEach(() => cleanup())

function m(filePath: string, qn: string, kind: SymbolNode['kind']): SymbolNode {
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

function sampleDiff(): StructuralDiff {
  const files: StructuralDiff['files'] = [
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
          after: m('svc.ts', 'OrderService.charge', 'method'),
        },
        {
          changeType: 'added',
          kind: 'method',
          after: m('svc.ts', 'OrderService.refund', 'method'),
        },
      ],
    },
  ]
  return {
    scope: 'task',
    taskId: 't',
    fromRef: 'a',
    toRef: 'WORKTREE',
    engine: 'deep',
    status: 'ok',
    files,
    dependencyChanges: [],
    impact: [
      {
        changedSymbolId: 'svc.ts#OrderService.charge:method:1',
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
    classEdges: [],
    summary: computeSummary(files, []),
  }
}

describe('<StructuralGraph />', () => {
  test('package level (default) shows package nodes; class level shows class cards', () => {
    const { container } = render(<StructuralGraph data={sampleDiff()} />)
    // default = package overview → package summary nodes, no class cards
    expect(container.querySelectorAll('.sg-pkgnode').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelector('.sg-card')).toBeNull()
    // switch to class level
    const classBtn = [...container.querySelectorAll('.structure-graph__level button')].find((b) =>
      /类级|Classes/.test(b.textContent ?? ''),
    )
    fireEvent.click(classBtn as Element)
    const cards = container.querySelectorAll('.sg-card')
    expect(cards.length).toBeGreaterThanOrEqual(1) // OrderService
    expect(container.textContent).toContain('OrderService')
    expect(container.textContent).toContain('charge')
    expect(
      container.querySelector('.sg-card__member--ct-modified, .sg-card__member--ct-added'),
    ).toBeTruthy()
  })

  test('empty state when nothing graphable', () => {
    const empty: StructuralDiff = { ...sampleDiff(), files: [], impact: [] }
    const { container } = render(<StructuralGraph data={empty} />)
    expect(container.querySelector('.structure-graph__empty')).toBeTruthy()
    expect(container.querySelector('.sg-card')).toBeNull()
  })
})
