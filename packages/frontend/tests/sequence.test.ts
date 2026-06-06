// RFC-085 T6 — sequence model: DFS pre-order messages, lifeline dedup, unresolved
// bucket, only-resolved recursion.

import { describe, expect, test } from 'vitest'
import {
  buildSequence,
  classDisplay,
  seqDiagramLayout,
  SEQ_COL_W,
  SEQ_PAD,
  UNRESOLVED_LIFELINE,
  type SeqCallNode,
} from '../src/lib/sequence'

const node = (
  ownerClass: string | null,
  method: string,
  resolution: SeqCallNode['resolution'],
  children: SeqCallNode[] = [],
): SeqCallNode => ({ ownerClass, method, resolution, children })

describe('buildSequence', () => {
  test('DFS pre-order messages + lifelines deduped in first-appearance order', () => {
    const model = buildSequence('f.java::A', [
      node('f.java::B', 'b()', 'resolved', [node('f.java::C', 'c()', 'resolved')]),
      node('f.java::B', 'b2()', 'resolved'),
    ])
    expect(model.participants).toEqual(['f.java::A', 'f.java::B', 'f.java::C'])
    expect(
      model.messages.map(
        (m) => `${classDisplay(m.from)}->${classDisplay(m.to)}:${m.label}@${m.depth}`,
      ),
    ).toEqual([
      'A->B:b()@0',
      'B->C:c()@1', // nested under b() — DFS pre-order
      'A->B:b2()@0',
    ])
  })

  test('only resolved nodes recurse (external/unresolved are leaves)', () => {
    const model = buildSequence('f::A', [
      node('f::B', 'b()', 'external', [node('f::Z', 'z()', 'resolved')]), // children ignored (external leaf)
    ])
    expect(model.messages).toHaveLength(1)
    expect(model.participants).toEqual(['f::A', 'f::B'])
  })

  test('unresolved call → the «unresolved» lifeline bucket', () => {
    const model = buildSequence('f::A', [node(null, 'mystery.x()', 'unresolved')])
    expect(model.participants).toEqual(['f::A', UNRESOLVED_LIFELINE])
    expect(model.messages[0]).toMatchObject({ to: UNRESOLVED_LIFELINE, resolution: 'unresolved' })
  })
})

describe('classDisplay', () => {
  test('leaf class name from a lifeline id', () => {
    expect(classDisplay('src/A.java::com.x.OrderService')).toBe('OrderService')
    expect(classDisplay(UNRESOLVED_LIFELINE)).toBe(UNRESOLVED_LIFELINE)
  })
})

// Regression: the rightmost participant's messages were clipped because the SVG
// width only counted participant columns, ignoring self-call labels drawn to the
// RIGHT of the last lifeline (svg overflow:hidden then cut them off). seqDiagramLayout
// must size the width to contain those labels. See SequenceDiagram.tsx + the
// task-detail 调用链 view right-edge truncation bug.
describe('seqDiagramLayout', () => {
  const columnsOnlyWidth = (n: number) => SEQ_PAD * 2 + n * SEQ_COL_W

  test('plain inter-participant calls fit within the columns', () => {
    const model = buildSequence('f::A', [node('f::B', 'x()', 'resolved')])
    const { width } = seqDiagramLayout(model)
    // short left-aligned labels never push past the 2-column box
    expect(width).toBe(columnsOnlyWidth(2))
  })

  test('a long self-call on the LAST lifeline widens the svg past the columns', () => {
    // self-call = from === to, drawn to the right of that lifeline.
    const longMethod = 'initializeComponentsWithAVeryLongDescriptiveName()'
    const model = buildSequence('f::A', [
      {
        ownerClass: 'f::B',
        method: 'go()',
        resolution: 'resolved',
        children: [
          { ownerClass: 'f::B', method: longMethod, resolution: 'resolved', children: [] },
        ],
      },
    ])
    const { width } = seqDiagramLayout(model)
    expect(width).toBeGreaterThan(columnsOnlyWidth(model.participants.length))
    // and it actually contains the label: last lifeline center + offset + text run
    const lastCenter = SEQ_PAD + (model.participants.length - 1) * SEQ_COL_W + SEQ_COL_W / 2
    expect(width).toBeGreaterThanOrEqual(lastCenter + 26 + longMethod.length * 6)
  })

  test('height grows one row per message', () => {
    const one = seqDiagramLayout(buildSequence('f::A', [node('f::B', 'x()', 'resolved')]))
    const two = seqDiagramLayout(
      buildSequence('f::A', [node('f::B', 'x()', 'resolved'), node('f::C', 'y()', 'resolved')]),
    )
    expect(two.height).toBeGreaterThan(one.height)
  })
})
