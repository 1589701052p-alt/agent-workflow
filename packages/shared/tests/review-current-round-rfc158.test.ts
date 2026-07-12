// RFC-158 — the shared "current review round" selector + human-conclusion
// predicate that BOTH getReviewDetail (renders it) and the task-detail canvas
// nav oracle (getTaskNodeRuns → reviewNavKind) derive from. Locking these keeps
// "the canvas marks a review clickable" ⟺ "the bare /reviews/{run} route renders
// that exact version" — the invariant six design-gate rounds converged on.
//
// selectCurrentReviewRound MIRRORS getReviewDetail (review.ts:1140-1177):
//   - single-doc: highest versionIndex INCLUDING superseded (NOT the
//     superseded-excluding deriveReviewRoundTiming — they diverge in the
//     superseded-top window and that divergence is exactly the R6 bug).
//   - multi-doc: pending members else newest (max reviewIteration, then max
//     roundGeneration) round; representative = itemIndex-ascending first.

import { describe, expect, test } from 'bun:test'

import {
  isHumanReviewConclusion,
  LOCAL_DECIDER,
  selectCurrentReviewRound,
  SYSTEM_DECIDER,
  type CurrentReviewRoundRow,
} from '../src/index'

type Row = CurrentReviewRoundRow & { id: string }

function row(p: Partial<Row> & Pick<Row, 'id' | 'versionIndex'>): Row {
  return {
    decision: 'pending',
    decidedBy: null,
    itemIndex: null,
    roundGeneration: null,
    reviewIteration: 0,
    ...p,
  }
}

describe('selectCurrentReviewRound — single-doc', () => {
  test('empty input → null (no doc_version; bare route would 404)', () => {
    expect(selectCurrentReviewRound([])).toBeNull()
  })

  test('picks the highest versionIndex; members = [representative]', () => {
    const rows = [
      row({ id: 'a', versionIndex: 1, decision: 'iterated', decidedBy: 'u1' }),
      row({ id: 'b', versionIndex: 2, decision: 'pending' }),
    ]
    const r = selectCurrentReviewRound(rows)
    expect(r?.representative.id).toBe('b')
    expect(r?.members.map((m) => m.id)).toEqual(['b'])
  })

  test('highest versionIndex INCLUDING superseded-top (mirrors getReviewDetail, not deriveReviewRoundTiming)', () => {
    // A human iterate at v1, then a v2 that got system-superseded. getReviewDetail
    // renders v2 (superseded) → the oracle must see v2, not fall back to v1.
    const rows = [
      row({ id: 'a', versionIndex: 1, decision: 'iterated', decidedBy: 'u1' }),
      row({ id: 'b', versionIndex: 2, decision: 'superseded', decidedBy: SYSTEM_DECIDER }),
    ]
    const r = selectCurrentReviewRound(rows)
    expect(r?.representative.id).toBe('b')
    // …and that representative is NOT a human conclusion → not "decided".
    expect(isHumanReviewConclusion(r?.representative ?? null)).toBe(false)
  })
})

describe('selectCurrentReviewRound — multi-doc', () => {
  test('pending members win; representative = itemIndex-ascending first', () => {
    const rows = [
      row({ id: 'm1', versionIndex: 2, itemIndex: 1, decision: 'pending', reviewIteration: 1 }),
      row({ id: 'm0', versionIndex: 2, itemIndex: 0, decision: 'pending', reviewIteration: 1 }),
      // an older decided round should be ignored while pending exists
      row({
        id: 'old',
        versionIndex: 1,
        itemIndex: 0,
        decision: 'approved',
        decidedBy: 'u1',
        reviewIteration: 0,
      }),
    ]
    const r = selectCurrentReviewRound(rows)
    expect(r?.representative.id).toBe('m0')
    expect(r?.members.map((m) => m.id)).toEqual(['m0', 'm1'])
  })

  test('no pending → newest round by max reviewIteration then max roundGeneration', () => {
    const rows = [
      // iteration 0 round (old)
      row({ id: 'i0', versionIndex: 1, itemIndex: 0, decision: 'iterated', decidedBy: 'u1' }),
      // iteration 1, generation 1 (superseded old gen)
      row({
        id: 'g1',
        versionIndex: 2,
        itemIndex: 0,
        decision: 'superseded',
        decidedBy: SYSTEM_DECIDER,
        reviewIteration: 1,
        roundGeneration: 1,
      }),
      // iteration 1, generation 2 (the live newest gen, decided by a human)
      row({
        id: 'g2',
        versionIndex: 3,
        itemIndex: 0,
        decision: 'approved',
        decidedBy: 'u1',
        reviewIteration: 1,
        roundGeneration: 2,
      }),
    ]
    const r = selectCurrentReviewRound(rows)
    expect(r?.representative.id).toBe('g2')
    expect(isHumanReviewConclusion(r?.representative ?? null)).toBe(true)
  })
})

describe('isHumanReviewConclusion', () => {
  test('approved/rejected/iterated by a non-system decider → true (incl. LOCAL_DECIDER)', () => {
    for (const decision of ['approved', 'rejected', 'iterated'] as const) {
      expect(isHumanReviewConclusion({ decision, decidedBy: 'user-123' })).toBe(true)
      expect(isHumanReviewConclusion({ decision, decidedBy: LOCAL_DECIDER })).toBe(true)
    }
  })

  test('system decider → false (sibling cascade / upstream-refresh supersede)', () => {
    for (const decision of ['approved', 'rejected', 'iterated', 'superseded'] as const) {
      expect(isHumanReviewConclusion({ decision, decidedBy: SYSTEM_DECIDER })).toBe(false)
    }
  })

  test('pending / superseded / null-decidedBy / null representative → false', () => {
    expect(isHumanReviewConclusion({ decision: 'pending', decidedBy: 'user-1' })).toBe(false)
    expect(isHumanReviewConclusion({ decision: 'superseded', decidedBy: 'user-1' })).toBe(false)
    expect(isHumanReviewConclusion({ decision: 'approved', decidedBy: null })).toBe(true)
    expect(isHumanReviewConclusion(null)).toBe(false)
    expect(isHumanReviewConclusion(undefined)).toBe(false)
  })
})
