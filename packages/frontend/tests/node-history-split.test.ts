// Locks the regression fix for the "重试列表 / Retries" panel inside the
// NodeDetailDrawer Stats tab: prior to splitNodeRunHistory, every sibling
// node_run with the same nodeId was lumped under "retries", which made
// loop / review / clarify iterations (all with retryIndex=0) appear as a
// pile of misleading "attempt 0" rows whose contents (prompt / outputs /
// events) differed wildly per click. See the conversation thread that
// produced node-history.ts for the original bug repro on agent_p69bj1
// where clarifyIteration went 0→1→2→3 but retryIndex stayed 0.

import { describe, expect, test } from 'vitest'
import type { NodeRun } from '@agent-workflow/shared'
import { formatIterationLabel, splitNodeRunHistory } from '../src/lib/node-history'

function makeRun(partial: Partial<NodeRun> & { id: string }): NodeRun {
  return {
    id: partial.id,
    taskId: 't1',
    nodeId: partial.nodeId ?? 'n1',
    parentNodeRunId: partial.parentNodeRunId ?? null,
    iteration: partial.iteration ?? 0,
    shardKey: partial.shardKey ?? null,
    retryIndex: partial.retryIndex ?? 0,
    reviewIteration: partial.reviewIteration ?? 0,
    clarifyIteration: partial.clarifyIteration ?? 0,
    status: partial.status ?? 'done',
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    pid: partial.pid ?? null,
    exitCode: partial.exitCode ?? null,
    errorMessage: partial.errorMessage ?? null,
    promptText: partial.promptText ?? null,
    tokInput: partial.tokInput ?? null,
    tokOutput: partial.tokOutput ?? null,
    tokTotal: partial.tokTotal ?? null,
    tokCacheCreate: partial.tokCacheCreate ?? null,
    tokCacheRead: partial.tokCacheRead ?? null,
    opencodeSessionId: partial.opencodeSessionId ?? null,
  }
}

// i18n stub: prints the key + the {{n}} interpolation so assertions stay
// readable without booting the i18next runtime.
const t = (key: string, vars?: Record<string, string | number>): string =>
  vars && 'n' in vars ? `${key}=${vars.n}` : key

describe('splitNodeRunHistory', () => {
  test('siblings on a different nodeId are ignored entirely', () => {
    const current = makeRun({ id: 'cur', nodeId: 'A' })
    const other = makeRun({ id: 'other', nodeId: 'B' })
    const { retries, iterations } = splitNodeRunHistory(current, [current, other])
    expect(retries).toEqual([])
    expect(iterations).toEqual([])
  })

  test('fan-out shard children (parentNodeRunId != null) are excluded', () => {
    const current = makeRun({ id: 'cur' })
    const shard = makeRun({ id: 'shard', parentNodeRunId: 'cur' })
    const { retries, iterations } = splitNodeRunHistory(current, [current, shard])
    expect(retries).toEqual([])
    expect(iterations).toEqual([])
  })

  test('current run itself is never returned in either list', () => {
    const current = makeRun({ id: 'cur', retryIndex: 1 })
    const { retries, iterations } = splitNodeRunHistory(current, [current])
    expect(retries.map((r) => r.id)).toEqual([])
    expect(iterations.map((r) => r.id)).toEqual([])
  })

  test('same iteration/review/clarify tuple, different retryIndex → retries (sorted)', () => {
    const current = makeRun({ id: 'cur', retryIndex: 2 })
    const r0 = makeRun({ id: 'r0', retryIndex: 0 })
    const r1 = makeRun({ id: 'r1', retryIndex: 1 })
    const { retries, iterations } = splitNodeRunHistory(current, [current, r1, r0])
    expect(retries.map((r) => r.id)).toEqual(['r0', 'r1'])
    expect(iterations).toEqual([])
  })

  test('different clarifyIteration goes to iterations, NOT retries', () => {
    // The exact agent_p69bj1 case from the original bug report.
    const c0 = makeRun({ id: 'c0', clarifyIteration: 0, startedAt: 100 })
    const c1 = makeRun({ id: 'c1', clarifyIteration: 1, startedAt: 200 })
    const c2 = makeRun({ id: 'c2', clarifyIteration: 2, startedAt: 300 })
    const cur = makeRun({ id: 'cur', clarifyIteration: 3, startedAt: 400, status: 'running' })
    const { retries, iterations } = splitNodeRunHistory(cur, [c0, c1, c2, cur])
    expect(retries).toEqual([])
    expect(iterations.map((r) => r.id)).toEqual(['c0', 'c1', 'c2'])
  })

  test('different reviewIteration goes to iterations', () => {
    const v0 = makeRun({ id: 'v0', reviewIteration: 0 })
    const v1 = makeRun({ id: 'v1', reviewIteration: 1 })
    const cur = makeRun({ id: 'cur', reviewIteration: 2 })
    const { retries, iterations } = splitNodeRunHistory(cur, [v0, v1, cur])
    expect(retries).toEqual([])
    expect(iterations.map((r) => r.id)).toEqual(['v0', 'v1'])
  })

  test('different loop iteration goes to iterations', () => {
    const i0 = makeRun({ id: 'i0', iteration: 0 })
    const i1 = makeRun({ id: 'i1', iteration: 1 })
    const cur = makeRun({ id: 'cur', iteration: 2 })
    const { retries, iterations } = splitNodeRunHistory(cur, [i0, i1, cur])
    expect(retries).toEqual([])
    expect(iterations.map((r) => r.id)).toEqual(['i0', 'i1'])
  })

  test('mix: same-tuple retries + other-iteration siblings split correctly', () => {
    const cur = makeRun({ id: 'cur', clarifyIteration: 2, retryIndex: 1 })
    const sameTupleRetry = makeRun({ id: 'rt', clarifyIteration: 2, retryIndex: 0 })
    const earlierIter = makeRun({ id: 'pi', clarifyIteration: 1, retryIndex: 0 })
    const earlierIterRetry = makeRun({ id: 'pi-rt', clarifyIteration: 1, retryIndex: 1 })
    const { retries, iterations } = splitNodeRunHistory(cur, [
      cur,
      sameTupleRetry,
      earlierIter,
      earlierIterRetry,
    ])
    expect(retries.map((r) => r.id)).toEqual(['rt'])
    // Iteration list shows every retry of past iterations — the user can
    // drill into a specific retry without leaving the drawer.
    expect(iterations.map((r) => r.id)).toEqual(['pi', 'pi-rt'])
  })

  test('iteration list sorts by (iteration, review, clarify, retryIndex)', () => {
    const a = makeRun({ id: 'a', iteration: 0, reviewIteration: 0, clarifyIteration: 2 })
    const b = makeRun({ id: 'b', iteration: 0, reviewIteration: 1, clarifyIteration: 0 })
    const c = makeRun({ id: 'c', iteration: 1, reviewIteration: 0, clarifyIteration: 0 })
    const cur = makeRun({ id: 'cur', iteration: 2 })
    const { iterations } = splitNodeRunHistory(cur, [c, b, a, cur])
    expect(iterations.map((r) => r.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('formatIterationLabel', () => {
  test('all counters zero → "initial"', () => {
    expect(formatIterationLabel(makeRun({ id: 'x' }), { t })).toBe('nodeDrawer.iterInitial')
  })

  test('only clarify non-zero → single chunk, no retry suffix', () => {
    expect(formatIterationLabel(makeRun({ id: 'x', clarifyIteration: 2 }), { t })).toBe(
      'nodeDrawer.iterClarify=2',
    )
  })

  test('loop + review + clarify joined with " · " in canonical order', () => {
    const run = makeRun({ id: 'x', iteration: 3, reviewIteration: 1, clarifyIteration: 2 })
    expect(formatIterationLabel(run, { t })).toBe(
      'nodeDrawer.iterLoop=3 · nodeDrawer.iterReview=1 · nodeDrawer.iterClarify=2',
    )
  })

  test('retryIndex > 0 appends a retry chunk', () => {
    const run = makeRun({ id: 'x', clarifyIteration: 1, retryIndex: 2 })
    expect(formatIterationLabel(run, { t })).toBe(
      'nodeDrawer.iterClarify=1 · nodeDrawer.iterRetry=2',
    )
  })

  test('all counters zero but retryIndex > 0 → "initial · retry#N"', () => {
    // Edge case: a retry of the initial attempt shouldn't drop the
    // "initial" anchor or we'd render a bare "retry#1" with no context.
    const run = makeRun({ id: 'x', retryIndex: 1 })
    expect(formatIterationLabel(run, { t })).toBe('nodeDrawer.iterInitial · nodeDrawer.iterRetry=1')
  })
})
