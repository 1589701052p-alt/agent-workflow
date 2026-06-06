// RFC-083 — per-node scope ref selection. "What did node N change" = the diff
// between N's pre_snapshot and the next write node's pre_snapshot (or worktree
// for the last writer); readonly nodes (no snapshot) contribute nothing.

import { describe, expect, test } from 'bun:test'
import { resolveNodeScope, type NodeRunRef } from '../src/services/structuralDiff/refSelect'

const runs: NodeRunRef[] = [
  { id: 'a', preSnapshot: 'snapA', startedAt: 1 },
  { id: 'r', preSnapshot: null, startedAt: 2 }, // readonly node (no snapshot)
  { id: 'b', preSnapshot: 'snapB', startedAt: 3 },
  { id: 'c', preSnapshot: 'snapC', startedAt: 4 }, // last writer
]

describe('resolveNodeScope', () => {
  test('middle write node → between its snapshot and the next write snapshot', () => {
    expect(resolveNodeScope(runs, 'a')).toEqual({
      kind: 'between',
      fromRef: 'snapA',
      toRef: 'snapB',
    })
    expect(resolveNodeScope(runs, 'b')).toEqual({
      kind: 'between',
      fromRef: 'snapB',
      toRef: 'snapC',
    })
  })

  test('last write node → diff against the worktree', () => {
    expect(resolveNodeScope(runs, 'c')).toEqual({ kind: 'to-worktree', fromRef: 'snapC' })
  })

  test('readonly node (no snapshot) → readonly', () => {
    expect(resolveNodeScope(runs, 'r')).toEqual({ kind: 'readonly' })
  })

  test('unknown node run → not-found', () => {
    expect(resolveNodeScope(runs, 'zzz')).toEqual({ kind: 'not-found' })
  })

  test('next-write selection ignores intervening readonly rows + respects start order', () => {
    // 'a' at t=1, then a readonly 'r' at t=2, then 'b' at t=3 → a pairs with b.
    const out = resolveNodeScope(runs, 'a')
    expect(out).toMatchObject({ kind: 'between', toRef: 'snapB' })
  })
})
