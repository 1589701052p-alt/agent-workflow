// RFC-085 T6 — sequence model: DFS pre-order messages, lifeline dedup, unresolved
// bucket, only-resolved recursion.

import { describe, expect, test } from 'vitest'
import {
  buildSequence,
  classDisplay,
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
