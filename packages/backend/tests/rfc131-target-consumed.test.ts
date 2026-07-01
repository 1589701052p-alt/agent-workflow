// RFC-131 T1 — isTargetNodeConsumed 派生式（时序）老化判据（design §2）。
//
// 核心正确性：一个 target 队列里、sinceMs（问题 dispatched_at）时下发的问题「已被产出老化」= 该
// (target, iteration) 有 top-level run done + output + startedAt >= sinceMs。
//   - done-无-output（问下一轮反问）NOT consumed → 不老化、下轮 rerun 继续注入（修多轮丢历史轮 + 天然
//     避免死锁）。
//   - 时序锚：一个 node 产出后可以再开新一轮反问（round N+1），那批新问题在上次产出之后下发，不能被
//     上次产出老化——只有「在问题下发之后才开跑的产出 run」才老化它。

import { describe, expect, test } from 'bun:test'

import type { nodeRuns } from '../src/db/schema'
import { isTargetNodeConsumed } from '../src/services/clarifyRerunLedger'

type NodeRunRow = typeof nodeRuns.$inferSelect
const T = 'agent_T'

function mkRun(over: Partial<NodeRunRow>): NodeRunRow {
  return {
    id: 'run',
    nodeId: T,
    iteration: 0,
    parentNodeRunId: null,
    status: 'done',
    startedAt: 1000,
    ...over,
  } as NodeRunRow
}

describe('isTargetNodeConsumed — RFC-131 派生式（时序）老化', () => {
  test('done + output（下发后产出）→ consumed（老化）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 0, [mkRun({ id: 'r1', status: 'done' })], new Set(['r1'])),
    ).toBe(true)
  })

  test('done 无 output（问下一轮反问）→ NOT consumed（不老化、下轮继续注入）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 0, [mkRun({ id: 'r1', status: 'done' })], new Set<string>()),
    ).toBe(false)
  })

  test('failed → NOT consumed（revivable）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 0, [mkRun({ id: 'r1', status: 'failed' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('pending / running → NOT consumed（在飞）', () => {
    expect(
      isTargetNodeConsumed(T, 0, 0, [mkRun({ id: 'r1', status: 'pending' })], new Set(['r1'])),
    ).toBe(false)
    expect(
      isTargetNodeConsumed(T, 0, 0, [mkRun({ id: 'r1', status: 'running' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('canceled → NOT consumed', () => {
    expect(
      isTargetNodeConsumed(T, 0, 0, [mkRun({ id: 'r1', status: 'canceled' })], new Set(['r1'])),
    ).toBe(false)
  })

  test('no run → NOT consumed', () => {
    expect(isTargetNodeConsumed(T, 0, 0, [], new Set<string>())).toBe(false)
  })

  test('iteration 隔离：done+output 在别的 iteration 不算', () => {
    const runs = [mkRun({ id: 'r1', status: 'done', iteration: 1 })]
    expect(isTargetNodeConsumed(T, 0, 0, runs, new Set(['r1']))).toBe(false)
    expect(isTargetNodeConsumed(T, 1, 0, runs, new Set(['r1']))).toBe(true)
  })

  test('node 隔离：别的 node done+output 不算', () => {
    expect(
      isTargetNodeConsumed(
        T,
        0,
        0,
        [mkRun({ id: 'r1', nodeId: 'other', status: 'done' })],
        new Set(['r1']),
      ),
    ).toBe(false)
  })

  test('fanout 子 run（parentNodeRunId 非 null）done+output 不算（只 top-level 产出）', () => {
    expect(
      isTargetNodeConsumed(
        T,
        0,
        0,
        [mkRun({ id: 'r1', status: 'done', parentNodeRunId: 'parent' })],
        new Set(['r1']),
      ),
    ).toBe(false)
  })

  test('混：一个 done-无-output + 一个 done+output → 老化（有产出即可）', () => {
    const runs = [mkRun({ id: 'r1', status: 'done' }), mkRun({ id: 'r2', status: 'done' })]
    expect(isTargetNodeConsumed(T, 0, 0, runs, new Set(['r2']))).toBe(true)
  })

  test('时序：产出早于问题下发（startedAt < sinceMs）→ NOT consumed（round N+1 新问题不被旧产出老化）', () => {
    const runs = [mkRun({ id: 'r1', status: 'done', startedAt: 500 })] // 旧产出 @500
    // 新问题在 @1000 下发（旧产出之后）→ 旧产出不老化它。
    expect(isTargetNodeConsumed(T, 0, 1000, runs, new Set(['r1']))).toBe(false)
    // 老问题在 @400 下发（旧产出之前）→ 被该产出老化。
    expect(isTargetNodeConsumed(T, 0, 400, runs, new Set(['r1']))).toBe(true)
  })
})
