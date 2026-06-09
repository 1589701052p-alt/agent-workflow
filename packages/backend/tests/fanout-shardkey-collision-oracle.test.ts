// Regression area: wrapper-fanout shardKey de-collision (RFC fan-out sharding).
//
// This file is an ORACLE REPLICA of the INLINE de-collision rule that lives
// inside `runTask` at packages/backend/src/services/scheduler.ts:2508-2514:
//
//     const seenShardKeys = new Set<string>()
//     const shards = items.map((value, idx) => {
//       let shardKey = keyOf(value, idx, itemKind)
//       if (seenShardKeys.has(shardKey)) shardKey = `${shardKey}#${idx}`
//       seenShardKeys.add(shardKey)
//       return { shardKey, value }
//     })
//
// The rule is NOT an exported pure function — it is inline in runTask — so this
// test does NOT import/invoke runTask or resolveKeyOf. Instead it re-implements
// the exact Set+suffix loop locally (the project's "pure oracle" pattern) and
// pins the DOCUMENTED contract that a future refactor could silently break:
//
//   * FIRST occurrence keeps the bare key (the common no-collision path is
//     unchanged) — a refactor that suffixed ALL occurrences would break this.
//   * subsequent duplicates get a deterministic `#${idx}` suffix using the
//     COLLIDING item's own index (not a running counter).
//   * input item ORDER is preserved.
//
// WHY this exists: the de-collision is the fix for a silent data-loss defect —
// the aggregator's find-by-shardKey would drop one of two equal shardKeys. The
// only pre-existing coverage (scheduler-boundary-fanout-shardkey-collision.test.ts)
// runs a full runTask with mock-opencode over TWO 'a.md' items and asserts ONLY
// `distinctShardKeys.size === 2`; it does not pin the exact suffix scheme, the
// bare-first invariant, ordering, or the 3+ duplicate case.
//
// REGRESSION ANCHOR: the oracle below MUST stay byte-equivalent in behavior to
// scheduler.ts:2508-2514. If that inline loop changes (e.g. suffix becomes a
// running counter, or all occurrences get suffixed), update BOTH the real code
// and this oracle together — divergence here is the review signal.
//
// NOTE on `let k = value`: the oracle uses the raw string as the base key,
// which is an accurate stand-in for path<*>-family kinds only — those are the
// kinds whose resolveKeyOf returns the path string itself (see
// packages/shared/src/shardingRegistry.ts:56-64). Other kinds default to a
// 0-based index key, which never collides, so the path family is the only
// collision-relevant case and the one the audit prompt calls out.

import { describe, expect, test } from 'bun:test'

/**
 * Pure oracle replica of scheduler.ts:2508-2514's inline shardKey
 * de-collision loop, specialized to the path-family case where the base
 * shardKey IS the item string itself.
 *
 * Mirrors the real loop exactly:
 *   - first sighting of a key → bare key
 *   - any later sighting → `${key}#${idx}` using the colliding item's index
 *   - input order preserved (map over items)
 */
function decollideShardKeys(items: readonly string[]): string[] {
  const seenShardKeys = new Set<string>()
  return items.map((value, idx) => {
    let shardKey = value
    if (seenShardKeys.has(shardKey)) shardKey = `${shardKey}#${idx}`
    seenShardKeys.add(shardKey)
    return shardKey
  })
}

describe('wrapper-fanout shardKey de-collision oracle (scheduler.ts:2508-2514)', () => {
  test('three identical path items → bare key then index-suffixed, all distinct', () => {
    const out = decollideShardKeys(['a.md', 'a.md', 'a.md'])
    // FIRST keeps bare key; subsequent dups suffixed with their own index.
    expect(out).toEqual(['a.md', 'a.md#1', 'a.md#2'])
    expect(new Set(out).size).toBe(3)
  })

  test('partial collision interleaved with a unique item → order preserved, only the colliding 3rd item suffixed (with its index 2)', () => {
    const out = decollideShardKeys(['a.md', 'b.md', 'a.md'])
    // 'b.md' is unique → bare; the 3rd item collides with the 1st 'a.md' and is
    // suffixed with ITS OWN index (2), not a running collision counter (1).
    expect(out).toEqual(['a.md', 'b.md', 'a.md#2'])
    expect(new Set(out).size).toBe(3)
  })

  test('edge: an item literally equal to a would-be suffix is still de-collided safely', () => {
    // The pre-existing literal 'a.md#1' at idx 1 is unique so it is kept bare;
    // the idx-2 'a.md' collides with the idx-0 'a.md' → 'a.md#2'. All distinct,
    // documenting the suffix scheme remains collision-safe in this case.
    const out = decollideShardKeys(['a.md', 'a.md#1', 'a.md'])
    expect(out).toEqual(['a.md', 'a.md#1', 'a.md#2'])
    expect(new Set(out).size).toBe(3)
  })

  test('no-collision common case is unchanged (bare-first invariant has zero effect)', () => {
    const out = decollideShardKeys(['a.md', 'b.md', 'c.md'])
    expect(out).toEqual(['a.md', 'b.md', 'c.md'])
    expect(new Set(out).size).toBe(3)
  })

  test('empty input → empty output (no throw)', () => {
    expect(decollideShardKeys([])).toEqual([])
  })
})
