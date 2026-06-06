// RFC-085 — call-chain expand decision (cycle + depth guards) + ref decoding
// (RFC-087 #private-member regression guard) + the bounded sequence walk.

import { describe, expect, test } from 'vitest'
import {
  expandState,
  refLabel,
  refFromMemberId,
  walkChainTree,
  MAX_CHAIN_DEPTH,
  type CallTarget,
} from '../src/lib/callChain'

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
  test('TS #private member: splits on first # only (RFC-087 regression)', () => {
    expect(refLabel('Svc.ts#Svc.#secret')).toBe('#secret()')
  })
})

describe('refFromMemberId (RFC-087 #private regression)', () => {
  test('strips :kind:row suffix to the backend methodRef', () => {
    expect(refFromMemberId('svc.ts#OrderService.charge:method:12')).toBe(
      'svc.ts#OrderService.charge',
    )
  })
  test('a #private qn keeps its literal # (split-on-# would corrupt it)', () => {
    // id has TWO '#': file# ... .#secret — the old split('#')[1] gave "Svc." (broken)
    expect(refFromMemberId('Svc.ts#Svc.#secret:method:2')).toBe('Svc.ts#Svc.#secret')
  })
})

describe('walkChainTree — bounded eager walk + truncation (#17)', () => {
  const tg = (label: string, ref?: string, ownerClass?: string, order = 0): CallTarget => ({
    label,
    ref,
    ownerClass,
    order,
    kind: 'method',
    resolution: ref === undefined ? 'unresolved' : 'resolved',
  })

  test('cycle (callee ref already an ancestor) → stops + flags truncated', async () => {
    const fetcher = async (ref: string): Promise<CallTarget[]> =>
      ref === 'f#A.a' ? [tg('b()', 'f#A.b', 'f::A')] : [tg('a()', 'f#A.a', 'f::A')] // a→b→a
    const { tree, truncated } = await walkChainTree('f#A.a', fetcher, {
      maxNodes: 50,
      maxDepth: 50,
    })
    expect(truncated).toBe(true) // the back-edge to a was not expanded
    expect(tree[0]?.children[0]?.method).toBe('a()')
    expect(tree[0]?.children[0]?.children).toEqual([]) // cycle stop, no recursion
  })

  test('depth cap → flags truncated', async () => {
    const fetcher = async (): Promise<CallTarget[]> => [tg('deeper()', 'f#A.x', 'f::A')]
    const { truncated } = await walkChainTree('f#A.root', fetcher, { maxNodes: 99, maxDepth: 2 })
    expect(truncated).toBe(true)
  })

  test('node cap → flags truncated + stops', async () => {
    const fetcher = async (): Promise<CallTarget[]> => [
      tg('x()', undefined, undefined, 0),
      tg('y()', undefined, undefined, 1),
      tg('z()', undefined, undefined, 2),
    ]
    const { tree, truncated } = await walkChainTree('f#A.root', fetcher, {
      maxNodes: 2,
      maxDepth: 9,
    })
    expect(truncated).toBe(true)
    expect(tree).toHaveLength(2)
  })

  test('finite acyclic chain → no truncation', async () => {
    const fetcher = async (ref: string): Promise<CallTarget[]> =>
      ref === 'f#A.a' ? [tg('b()', 'f#A.b', 'f::A')] : []
    const { truncated, tree } = await walkChainTree('f#A.a', fetcher, { maxNodes: 9, maxDepth: 9 })
    expect(truncated).toBe(false)
    expect(tree[0]?.method).toBe('b()')
  })
})
