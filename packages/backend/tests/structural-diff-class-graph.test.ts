// RFC-083 PR-G — class-level inherit/reference edges. Locks: a class that
// constructs/uses another → 'references'; extends/implements (Java/TS) + Python
// `class X(Base)` → 'inherits' (and inheritance wins over a plain reference for
// the same pair); unrelated classes → no edge.

import { describe, expect, test } from 'bun:test'
import {
  collectClassNodes,
  computeClassEdges,
  type ClassNode,
} from '../src/services/structuralDiff/classGraph'
import type { FileStructuralDiff, SymbolNode } from '@agent-workflow/shared'

const node = (key: string, name: string, file: string, a: number, b: number): ClassNode => ({
  key,
  name,
  file,
  range: { startLine: a, endLine: b },
})

describe('computeClassEdges', () => {
  test('A constructs B → references edge (one-directional)', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 5), node('b.ts::B', 'B', 'b.ts', 1, 3)]
    const fileText = new Map([
      ['a.ts', 'class A {\n  m() {\n    return new B()\n  }\n}'],
      ['b.ts', 'class B {\n  k() {}\n}'],
    ])
    const edges = computeClassEdges(nodes, fileText)
    expect(edges).toEqual([{ from: 'a.ts::A', to: 'b.ts::B', kind: 'references' }])
  })

  test('A extends B → inheritance edge, and it wins over a reference for the pair', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 3), node('b.ts::B', 'B', 'b.ts', 1, 2)]
    const fileText = new Map([
      ['a.ts', 'class A extends B {\n  m() { return new B() }\n}'],
      ['b.ts', 'class B {}'],
    ])
    const edges = computeClassEdges(nodes, fileText)
    expect(edges.filter((e) => e.from === 'a.ts::A' && e.to === 'b.ts::B')).toEqual([
      { from: 'a.ts::A', to: 'b.ts::B', kind: 'inherits' },
    ])
  })

  test('Python class(Base) → inheritance', () => {
    const nodes = [
      node('m.py::Dog', 'Dog', 'm.py', 1, 2),
      node('m.py::Animal', 'Animal', 'm.py', 4, 5),
    ]
    const fileText = new Map([
      ['m.py', 'class Dog(Animal):\n    pass\n\nclass Animal:\n    pass\n'],
    ])
    expect(computeClassEdges(nodes, fileText)).toContainEqual({
      from: 'm.py::Dog',
      to: 'm.py::Animal',
      kind: 'inherits',
    })
  })

  test('unrelated classes → no edges', () => {
    const nodes = [node('a.ts::A', 'A', 'a.ts', 1, 2), node('b.ts::B', 'B', 'b.ts', 1, 2)]
    const fileText = new Map([
      ['a.ts', 'class A { m() { return 1 } }'],
      ['b.ts', 'class B { k() { return 2 } }'],
    ])
    expect(computeClassEdges(nodes, fileText)).toEqual([])
  })

  test('fewer than 2 classes → no edges', () => {
    expect(
      computeClassEdges([node('a::A', 'A', 'a', 1, 2)], new Map([['a', 'class A {}']])),
    ).toEqual([])
  })
})

describe('collectClassNodes', () => {
  test('picks changed class symbols with ranges', () => {
    const cls = (qn: string): SymbolNode => ({
      id: `f.ts#${qn}:class:1`,
      kind: 'class',
      name: qn,
      qualifiedName: qn,
      lang: 'typescript',
      filePath: 'f.ts',
      range: { startLine: 1, endLine: 4 },
      confidence: 'extracted',
    })
    const files: FileStructuralDiff[] = [
      {
        filePath: 'f.ts',
        lang: 'typescript',
        status: 'ok',
        edges: [],
        impact: [],
        changes: [
          { changeType: 'added', kind: 'class', after: cls('Widget') },
          // a method change must NOT become a class node
          {
            changeType: 'modified',
            kind: 'method',
            after: { ...cls('Widget.run'), kind: 'method', qualifiedName: 'Widget.run' },
          },
        ],
      },
    ]
    const nodes = collectClassNodes(files)
    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ key: 'f.ts::Widget', name: 'Widget', file: 'f.ts' })
  })
})
