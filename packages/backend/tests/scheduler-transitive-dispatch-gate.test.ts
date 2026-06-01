// RFC-074 follow-up — transitive dispatch gate (fix A).
//
// WHY THIS FILE EXISTS (regression intent):
//   Incident task 01KT1HDYV6RA8EJGY5BSE20MH9 (same graph shape as
//   01KS86DPCSERV7S41GQA5Y81RN): in → designer → rev1 → questioner → rev2 → out,
//   plus a cross-clarify cycle letting the downstream questioner ask the upstream
//   designer back. A cross-clarify answer re-ran the GRANDPARENT designer
//   out-of-band. runScope's per-batch ready computation gated on DIRECT upstreams
//   only (`ups.every((u) => completed.has(u))`). The intermediate review rev1
//   still showed its STALE `done` row (one-hop-fresh, not yet demoted), so
//   `completed.has(rev1)` was true and the questioner dispatched in the SAME
//   batch — 198ms after the designer rerun finished — consuming an approved_doc
//   that no longer matched the revised design. rev1 was only demoted to
//   awaiting_review AFTER the questioner had already burned a full run. i.e. the
//   re-review the rerun should have FORCED was skipped, and the downstream ran on
//   a stale approval.
//
//   Fix A makes the dispatch gate transitive: a node dispatches only once its
//   WHOLE structural ancestor chain is `completed`. The questioner now waits
//   until designer re-settles AND rev1 is re-approved (the A→R→C cascade).
//
// The two oracles below (`oneHopReady` = the OLD gate, `computeReadyNodes` = the
// fix) are run against the IDENTICAL bug-window state; the divergence on
// `questioner` is exactly the bug this file locks. If `computeReadyNodes` ever
// regresses to one-hop, the first test goes red.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { areTransitiveUpstreamsCompleted, computeReadyNodes } from '../src/services/freshness'

// Structural upstreams for the incident graph, exactly as buildScopeUpstreams
// would yield them: the cross-clarify back-edges (to_designer / to_questioner →
// __external_feedback__ / __clarify_response__) are DROPPED, so the dispatch DAG
// is the clean chain in → designer → rev1 → questioner → rev2 → out, with cross1
// depending on the questioner (questioner.__clarify__ → cross1.questions, kept).
function incidentUpstreams(): Map<string, string[]> {
  return new Map<string, string[]>([
    ['in', []],
    ['designer', ['in']],
    ['rev1', ['designer']],
    ['questioner', ['rev1']],
    ['rev2', ['questioner']],
    ['out', ['rev2']],
    ['cross1', ['questioner']],
  ])
}

// The OLD one-hop gate, re-implemented here so the test pins the exact behavior
// the fix replaces (and proves the bug-window state genuinely reproduces it).
function oneHopReady<N extends { id: string }>(
  remaining: Iterable<N>,
  upstreamsOf: Map<string, string[]>,
  completed: ReadonlySet<string>,
): N[] {
  const ready: N[] = []
  for (const n of remaining) {
    const ups = upstreamsOf.get(n.id) ?? []
    if (ups.every((u) => completed.has(u))) ready.push(n)
  }
  return ready
}

const ids = (ns: { id: string }[]): string[] => ns.map((n) => n.id).sort()
const nodes = (...xs: string[]): { id: string }[] => xs.map((id) => ({ id }))

describe('RFC-074 follow-up — transitive dispatch gate (incident 01KT1HDYV6RA8EJGY5BSE20MH9)', () => {
  test('bug window: grandchild questioner is held while grandparent designer re-runs (one-hop would dispatch it)', () => {
    const ups = incidentUpstreams()
    // Cross-clarify answer just landed:
    //   - designer re-minted as a fresh pending row → NOT in completed
    //   - rev1 still carries its stale `done` (one-hop-fresh, not yet demoted)
    //   - questioner re-minted pending (to_questioner back-channel) → in remaining
    //   - cross1 already done (it produced the answer)
    const completed = new Set<string>(['in', 'rev1', 'cross1'])
    const remaining = nodes('designer', 'questioner', 'rev2', 'out')

    // The OLD gate dispatches BOTH designer AND the questioner — the questioner
    // riding rev1's stale approval. THIS is the incident.
    expect(ids(oneHopReady(remaining, ups, completed))).toEqual(['designer', 'questioner'])

    // The fix: only designer is ready. The questioner waits because its
    // transitive ancestor `designer` is not yet settled, so rev1's approval is
    // about to be invalidated and must be re-reviewed first.
    expect(ids(computeReadyNodes(remaining, ups, completed))).toEqual(['designer'])
  })

  test('cascade order A→R→C: questioner only dispatches after designer re-settles AND rev1 is re-approved', () => {
    const ups = incidentUpstreams()

    // Step 1 — designer rerun finished; per-batch demote pulled rev1 out of
    // completed (its consumed designer run is no longer freshest) → rev1 back in
    // remaining for re-review. completed = { in, designer }.
    let completed = new Set<string>(['in', 'designer'])
    let remaining = nodes('rev1', 'questioner', 'rev2', 'out')
    // Only the re-review is ready; the questioner is still gated on rev1.
    expect(ids(computeReadyNodes(remaining, ups, completed))).toEqual(['rev1'])

    // Step 2 — rev1 is re-dispatched and parks awaiting_review (not done → not
    // in completed). Nothing downstream is ready: the task correctly bubbles
    // awaiting_review to the human instead of running the questioner.
    completed = new Set<string>(['in', 'designer'])
    remaining = nodes('questioner', 'rev2', 'out') // rev1 mid-review, removed from remaining
    expect(ids(computeReadyNodes(remaining, ups, completed))).toEqual([])

    // Step 3 — human re-approves rev1 → rev1 done again, in completed. NOW the
    // questioner dispatches, consuming the re-reviewed approval. Correct order.
    completed = new Set<string>(['in', 'designer', 'rev1'])
    remaining = nodes('questioner', 'rev2', 'out')
    expect(ids(computeReadyNodes(remaining, ups, completed))).toEqual(['questioner'])
  })

  test('steady state is unchanged: transitive gate equals one-hop when the chain is fully settled', () => {
    const ups = incidentUpstreams()
    const completed = new Set<string>(['in', 'designer', 'rev1'])
    const remaining = nodes('questioner', 'rev2', 'out')
    // No mid-run rerun → both gates agree (the fix only diverges in the bug
    // window, so existing happy-path scheduler behavior is preserved).
    expect(ids(computeReadyNodes(remaining, ups, completed))).toEqual(
      ids(oneHopReady(remaining, ups, completed)),
    )
    expect(ids(computeReadyNodes(remaining, ups, completed))).toEqual(['questioner'])
  })
})

describe('areTransitiveUpstreamsCompleted — pure semantics', () => {
  test('node with no upstreams is always ready (input node)', () => {
    expect(areTransitiveUpstreamsCompleted('in', incidentUpstreams(), new Set())).toBe(true)
  })

  test('direct upstream missing → not ready', () => {
    const ups = new Map<string, string[]>([['b', ['a']]])
    expect(areTransitiveUpstreamsCompleted('b', ups, new Set())).toBe(false)
    expect(areTransitiveUpstreamsCompleted('b', ups, new Set(['a']))).toBe(true)
  })

  test('full chain completed → ready; a gap anywhere in the chain → not ready', () => {
    const ups = new Map<string, string[]>([
      ['a', []],
      ['b', ['a']],
      ['c', ['b']],
      ['d', ['c']],
    ])
    expect(areTransitiveUpstreamsCompleted('d', ups, new Set(['a', 'b', 'c']))).toBe(true)
    // 'b' completed but its ancestor 'a' is not — the exact transitive hole the
    // one-hop gate misses.
    expect(areTransitiveUpstreamsCompleted('d', ups, new Set(['b', 'c']))).toBe(false)
    expect(areTransitiveUpstreamsCompleted('c', ups, new Set(['b']))).toBe(false)
  })

  test('diamond: a node ready via two paths is evaluated once and correctly', () => {
    // a → b, a → c, b → d, c → d
    const ups = new Map<string, string[]>([
      ['a', []],
      ['b', ['a']],
      ['c', ['a']],
      ['d', ['b', 'c']],
    ])
    expect(areTransitiveUpstreamsCompleted('d', ups, new Set(['a', 'b', 'c']))).toBe(true)
    // Drop 'a' (shared grandparent): both paths fail → not ready.
    expect(areTransitiveUpstreamsCompleted('d', ups, new Set(['b', 'c']))).toBe(false)
  })

  test('cycle in the upstream map does not loop forever (defensive)', () => {
    // Should never happen (back-edges are dropped) but the seen-set must guard.
    const ups = new Map<string, string[]>([
      ['x', ['y']],
      ['y', ['x']],
    ])
    // Completes (no infinite recursion); with both present it resolves true.
    expect(areTransitiveUpstreamsCompleted('x', ups, new Set(['x', 'y']))).toBe(true)
    expect(areTransitiveUpstreamsCompleted('x', ups, new Set(['y']))).toBe(false)
  })
})

describe('source guard — runScope wires the transitive gate', () => {
  const SCHEDULER_SRC = readFileSync(
    resolve(import.meta.dir, '..', 'src', 'services', 'scheduler.ts'),
    'utf8',
  )

  test('runScope calls computeReadyNodes and no longer hand-rolls the one-hop gate', () => {
    expect(SCHEDULER_SRC).toContain('computeReadyNodes(remaining.values()')
    // The old hand-rolled ready loop ended in `ready.push(n)` — a code-only
    // token (the prose comment above the call deliberately quotes the one-hop
    // EXPRESSION but never `ready.push`). Its absence locks out a re-inlined
    // one-hop gate without tripping on documentation.
    expect(SCHEDULER_SRC).not.toContain('ready.push(n)')
  })
})
