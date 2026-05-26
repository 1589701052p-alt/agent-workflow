// RFC-064 PR-A T1 — shared baseline lock for clarify runtime unification.
//
// This file is the *PR-A baseline* for RFC-064 — it locks in the user-observable
// behavior of the shared layer BEFORE PR-B removes the
// `node_runs.cross_clarify_iteration` column. The contract is:
//
//   - PR-A (this commit): asserts current state — NodeRunSchema has BOTH
//     `clarifyIteration` and `crossClarifyIteration` fields, both default 0;
//     applyAgingCutoff handles the four canonical edge cases
//     (empty rows / cutoff=0 / cutoff=undefined / all filtered).
//   - PR-B: T10 deletes the `crossClarifyIteration` field — this file's
//     `crossClarifyIteration optional default 0` case will be REWRITTEN by
//     T15.5 sweep to no longer reference the deleted field. The cutoff
//     behavior cases (S3-S6) MUST remain byte-level unchanged across PR-B.
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
  crossClarifyIteration: 0,
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

describe('RFC-064 PR-A baseline: NodeRunSchema field set (locks current 2-counter shape)', () => {
  test('S1: NodeRunSchema parses a row with clarifyIteration=N and crossClarifyIteration=M (both fields present today)', () => {
    const parsed = NodeRunSchema.parse({
      ...BASE_RUN,
      clarifyIteration: 3,
      crossClarifyIteration: 2,
    })
    expect(parsed.clarifyIteration).toBe(3)
    // The cross field is still part of the wire shape pre-PR-B; T15.5 sweep
    // will drop this single line when the field is removed from the schema.
    expect((parsed as { crossClarifyIteration?: number }).crossClarifyIteration).toBe(2)
  })

  test('S2: NodeRunSchema defaults clarifyIteration=0 + crossClarifyIteration=0 when both omitted', () => {
    const { crossClarifyIteration: _omitCci, clarifyIteration: _omitCli, ...rest } = BASE_RUN
    const parsed = NodeRunSchema.parse(rest)
    expect(parsed.clarifyIteration).toBe(0)
    // Pre-PR-B: cci defaults to 0 via the schema. T15.5 sweep deletes this.
    expect((parsed as { crossClarifyIteration?: number }).crossClarifyIteration).toBe(0)
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
