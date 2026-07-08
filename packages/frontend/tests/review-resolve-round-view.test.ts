// Pure-function tests for RFC-149 `resolveRoundView` — the multi-doc twin of
// RFC-013's `resolveReviewView` (review-resolve-view.test.ts). The multi-doc
// review page's `?round=<roundKey>` branch (readonly banner / hidden write
// affordances / member navigator source) is driven entirely off the
// discriminated union this returns, so the table below is the contract the
// page is allowed to depend on.
//
// Rule 3 (rounds still loading → OPTIMISTIC historical) is a DELIBERATE
// RFC-149 behavior change: the multi-doc page used to block on a full-page
// spinner while the rounds list loaded, where the single-doc page already
// rendered the read-only shell with placeholder labels. The resolver now
// encodes the single-doc semantics for both surfaces.

import { describe, expect, it } from 'vitest'
import type { ReviewRoundSummary } from '@agent-workflow/shared'
import { resolveRoundView } from '@/lib/review/readonly'

function round(
  roundKey: string,
  isCurrent: boolean,
  decision: ReviewRoundSummary['decision'] = 'iterated',
): ReviewRoundSummary {
  return {
    roundKey,
    reviewIteration: 0,
    roundGeneration: 1,
    decision,
    decisionReason: null,
    decidedAt: null,
    decidedBy: null,
    decidedByRole: null,
    createdAt: 0,
    isCurrent,
    members: [],
  }
}

describe('resolveRoundView', () => {
  it('returns current when roundQuery is undefined', () => {
    expect(resolveRoundView(undefined, [round('g1', true)])).toEqual({ mode: 'current' })
  })

  it('returns current when roundQuery is empty string', () => {
    expect(resolveRoundView('', [round('g1', true)])).toEqual({ mode: 'current' })
  })

  it('returns current when the key hits the CURRENT round (?round= ≡ no param)', () => {
    const rounds = [round('g1', false), round('g2', true, 'pending')]
    expect(resolveRoundView('g2', rounds)).toEqual({ mode: 'current' })
  })

  it('returns historical with round + index hydrated when the key hits a retired round', () => {
    const g1 = round('g1', false, 'rejected')
    const rounds = [g1, round('g2', true, 'pending')]
    expect(resolveRoundView('g1', rounds)).toEqual({
      mode: 'historical',
      roundKey: 'g1',
      round: g1,
      roundIndex: 0,
    })
  })

  it('returns historical (unhydrated) OPTIMISTICALLY while rounds are loading — single-doc parity', () => {
    // Deliberate RFC-149 alignment: no full-page loading block anymore; the
    // shell renders read-only with placeholders until the rounds list lands.
    expect(resolveRoundView('g1', undefined)).toEqual({
      mode: 'historical',
      roundKey: 'g1',
    })
  })

  it('returns invalid when rounds loaded but the key is unknown', () => {
    const rounds = [round('g1', false), round('g2', true, 'pending')]
    expect(resolveRoundView('nope', rounds)).toEqual({ mode: 'invalid', requested: 'nope' })
  })

  it('returns invalid for unknown key even when rounds array is empty (post-load)', () => {
    expect(resolveRoundView('g9', [])).toEqual({ mode: 'invalid', requested: 'g9' })
  })
})
