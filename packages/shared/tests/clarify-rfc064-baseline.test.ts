// RFC-064 PR-B T1 — shared baseline lock for clarify runtime unification.
//
// After RFC-064 PR-B collapsed the two clarify counters into one, this file
// locks the unified `clarifyIteration` field set + the four canonical
// applyAgingCutoff edge cases (empty rows / cutoff=0 / cutoff=undefined /
// all filtered). The cutoff behavior is byte-for-byte unchanged across the
// PR-A → PR-B transition; only the schema-side cases lost their
// `crossClarifyIteration` reference when T10 deleted the field.
//
// See RFC-064 plan.md T1 for the ≥6 case budget and RFC-064 design.md §2 for
// the schema-layer scope.

import { describe, expect, test } from 'bun:test'

import { applyAgingCutoff } from '../src/clarify-aging'
import { NodeRunSchema } from '../src/schemas/task'

const BASE_RUN = {
  id: 'run_01JABCDEF',
  taskId: 't_001',
  nodeId: 'agent-1',
  parentNodeRunId: null,
  iteration: 0,
  shardKey: null,
  retryIndex: 0,
  reviewIteration: 0,
  clarifyIteration: 0,
  status: 'done' as const,
  startedAt: 1,
  finishedAt: 2,
  pid: 1000,
  exitCode: 0,
  errorMessage: null,
  promptText: null,
  tokInput: null,
  tokOutput: null,
  tokTotal: null,
  tokCacheCreate: null,
  tokCacheRead: null,
  opencodeSessionId: null,
}

describe('RFC-064 PR-B baseline: NodeRunSchema field set (locks unified single-counter shape)', () => {
  test('S1: NodeRunSchema parses a row with clarifyIteration=N (covers both self + cross after unification)', () => {
    const parsed = NodeRunSchema.parse({
      ...BASE_RUN,
      clarifyIteration: 3,
    })
    expect(parsed.clarifyIteration).toBe(3)
  })

  test('S2: NodeRunSchema defaults clarifyIteration=0 when omitted', () => {
    const { clarifyIteration: _omit, ...rest } = BASE_RUN
    const parsed = NodeRunSchema.parse(rest)
    expect(parsed.clarifyIteration).toBe(0)
  })
})

describe('RFC-064 PR-A baseline: applyAgingCutoff edge cases (byte-level stable across PR-B)', () => {
  test('S3: empty rows + any cutoff → empty result', () => {
    expect(applyAgingCutoff([], 0)).toEqual([])
    expect(applyAgingCutoff([], 5)).toEqual([])
    expect(applyAgingCutoff([], undefined)).toEqual([])
  })

  test('S4: cutoff=0 keeps all rows (iteration >= 0 always true)', () => {
    const rows = [{ iteration: 0 }, { iteration: 1 }, { iteration: 5 }]
    expect(applyAgingCutoff(rows, 0)).toEqual(rows)
    // Returned array is a shallow copy — mutation of result must not touch input.
    const result = applyAgingCutoff(rows, 0)
    result.pop()
    expect(rows.length).toBe(3)
  })

  test('S5: cutoff=undefined → shallow copy of input (no filter)', () => {
    const rows = [{ iteration: 0 }, { iteration: 3 }]
    const result = applyAgingCutoff(rows, undefined)
    expect(result).toEqual(rows)
    // Mutation-safety guarantee from clarify-aging.ts header.
    expect(result).not.toBe(rows)
  })

  test('S6: cutoff above all → empty result (full prune)', () => {
    const rows = [{ iteration: 0 }, { iteration: 1 }, { iteration: 2 }]
    expect(applyAgingCutoff(rows, 5)).toEqual([])
  })
})
