// RFC-058 — schema tests for the new unified clarify_rounds wire shape +
// applyAgingCutoff helper. These tests are part of PR-B T9; they prove the
// new types parse correctly and the cutoff helper handles the four canonical
// scenarios (undefined / 0 / N / full-prune).
//
// PR-B T17 will add the source-grep guard that the OLD type names
// (ClarifySession / CrossClarifySession / ClarifyInboxEntry / etc.) are
// absent from shared/ and frontend/. Those tests deliberately come after the
// migration + service merge so they don't tip red prematurely.

import { describe, expect, test } from 'bun:test'

import {
  ClarifyRoundKindSchema,
  ClarifyRoundSchema,
  ClarifyRoundStatusSchema,
  ClarifyRoundSummarySchema,
  applyAgingCutoff,
} from '../src/index'

describe('RFC-058 ClarifyRoundKindSchema', () => {
  test('accepts self + cross literals', () => {
    expect(ClarifyRoundKindSchema.safeParse('self').success).toBe(true)
    expect(ClarifyRoundKindSchema.safeParse('cross').success).toBe(true)
  })

  test('rejects unknown kind', () => {
    expect(ClarifyRoundKindSchema.safeParse('hybrid').success).toBe(false)
  })
})

describe('RFC-058 ClarifyRoundStatusSchema', () => {
  test('all four statuses parse: awaiting_human + answered + canceled + abandoned', () => {
    for (const s of ['awaiting_human', 'answered', 'canceled', 'abandoned'] as const) {
      expect(ClarifyRoundStatusSchema.safeParse(s).success).toBe(true)
    }
  })
})

describe('RFC-058 ClarifyRoundSchema', () => {
  test('parses a kind="self" row (asking agent is its own consumer)', () => {
    const row = {
      id: 'r1',
      taskId: 't1',
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_d_0',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c_0',
      targetConsumerNodeId: null,
      loopIter: 0,
      iteration: 0,
      questions: [
        {
          id: 'q1',
          title: 'Pick',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'A', description: '', recommended: false, recommendationReason: '' },
            { label: 'B', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      directive: null,
      status: 'awaiting_human',
      sessionMode: null,
      designerRunTriggeredAt: null,
      abandonedAt: null,
      createdAt: 123,
      answeredAt: null,
      answeredBy: null,
    }
    const parsed = ClarifyRoundSchema.safeParse(row)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.kind).toBe('self')
      expect(parsed.data.targetConsumerNodeId).toBeNull()
    }
  })

  test('parses a kind="cross" row (questioner asks, designer consumes)', () => {
    const row = {
      id: 'r2',
      taskId: 't1',
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_0',
      askingShardKey: null,
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc_0',
      targetConsumerNodeId: 'designer',
      loopIter: 1,
      iteration: 0,
      questions: [
        {
          id: 'q1',
          title: 'Pick',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'X', description: '', recommended: false, recommendationReason: '' },
            { label: 'Y', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      directive: 'continue',
      status: 'answered',
      sessionMode: null,
      designerRunTriggeredAt: 1234,
      abandonedAt: null,
      createdAt: 123,
      answeredAt: 200,
      answeredBy: 'local',
    }
    const parsed = ClarifyRoundSchema.safeParse(row)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.kind).toBe('cross')
      expect(parsed.data.targetConsumerNodeId).toBe('designer')
      expect(parsed.data.loopIter).toBe(1)
    }
  })
})

describe('RFC-058 ClarifyRoundSummarySchema', () => {
  test('parses a compact summary entry', () => {
    const row = {
      id: 's1',
      taskId: 't1',
      taskName: 'task name',
      kind: 'self',
      askingNodeId: 'designer',
      askingShardKey: null,
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c_0',
      targetConsumerNodeId: null,
      loopIter: 0,
      iteration: 0,
      questionCount: 2,
      status: 'awaiting_human',
      directive: null,
      createdAt: 123,
      answeredAt: null,
    }
    expect(ClarifyRoundSummarySchema.safeParse(row).success).toBe(true)
  })
})

describe('RFC-058 applyAgingCutoff', () => {
  const sample = [
    { iteration: 0, id: 'a' },
    { iteration: 1, id: 'b' },
    { iteration: 2, id: 'c' },
  ]

  test('undefined cutoff is a no-op (returns shallow copy)', () => {
    const r = applyAgingCutoff(sample, undefined)
    expect(r).toEqual(sample)
    expect(r).not.toBe(sample) // shallow copy
  })

  test('cutoff=0 keeps all rows (iteration >= 0)', () => {
    expect(applyAgingCutoff(sample, 0)).toEqual(sample)
  })

  test('cutoff=1 drops iteration=0', () => {
    expect(applyAgingCutoff(sample, 1)).toEqual([sample[1]!, sample[2]!])
  })

  test('cutoff=5 prunes everything', () => {
    expect(applyAgingCutoff(sample, 5)).toEqual([])
  })
})
