// RFC-085 — call-chain expand decision (cycle + depth guards).

import { describe, expect, test } from 'vitest'
import { expandState, refLabel, MAX_CHAIN_DEPTH } from '../src/lib/callChain'

describe('expandState', () => {
  test('resolved, not on path, within depth → expandable', () => {
    expect(expandState({ ref: 'a.ts#X.y', resolution: 'resolved' }, new Set(), 1)).toBe(
      'expandable',
    )
  })

  test('external / unresolved (no usable ref) → leaf', () => {
    expect(expandState({ ref: undefined, resolution: 'unresolved' }, new Set(), 1)).toBe('leaf')
    expect(expandState({ ref: 'a.ts#X.y', resolution: 'external' }, new Set(), 1)).toBe('leaf')
  })

  test('ref already an ancestor → cycle (stops infinite recursion)', () => {
    expect(expandState({ ref: 'a.ts#X.y', resolution: 'resolved' }, new Set(['a.ts#X.y']), 3)).toBe(
      'cycle',
    )
  })

  test('depth cap → too-deep', () => {
    expect(
      expandState({ ref: 'a.ts#X.y', resolution: 'resolved' }, new Set(), MAX_CHAIN_DEPTH),
    ).toBe('too-deep')
  })
})

describe('refLabel', () => {
  test('leaf method name + ()', () => {
    expect(refLabel('src/A.java#OrderService.charge')).toBe('charge()')
    expect(refLabel('bare')).toBe('bare()')
  })
})
