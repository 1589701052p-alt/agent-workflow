// RFC-108 T1/T2 (AR-12 / AR-19 / 01-LIFE-01) — task.status transition-table oracle.
//
// 为什么这条测试存在：task 级状态机此前只有 CAS（RFC-097），转移合法性 `allowedFrom`
// 在 ~20 个调用点手抄、已现漂移（01-LIFE-02），与 node_run 的 `nextNodeRunStatus`
// 单表 + `never` 穷举不对称。本测试把新引入的 `nextTaskStatus` 对称 oracle 锁死：
//   ① nextTaskStatus(from,event) 要么返回 targetForTaskEvent(event)、要么抛
//      IllegalTaskTransition——与 allowedFromForTaskEvent 完全一致（property）；
//   ② 关键真实转移（resume / retry / interrupt / claim …）的合法源集锁定意图；
//   ③ TERMINAL_TASK_STATUSES 上提 shared（前端可同源 import，消 01-LIFE-08）。
// 新增 task 状态/事件时 targetForTaskEvent 的 never 穷举会编译失败，逼全覆盖。

import { describe, expect, test } from 'bun:test'

import { TASK_STATUS, type TaskStatus } from '../src/schemas/task'
import {
  IllegalTaskTransition,
  TERMINAL_TASK_STATUSES,
  allowedFromForTaskEvent,
  isTerminalTaskStatus,
  nextTaskStatus,
  targetForTaskEvent,
  type TaskTransitionEvent,
} from '../src/lifecycle'

const EVENTS: TaskTransitionEvent[] = [
  { kind: 'claim' },
  { kind: 'complete' },
  { kind: 'park-review' },
  { kind: 'park-human' },
  { kind: 'unpark' },
  { kind: 'fail' },
  { kind: 'cancel' },
  { kind: 'interrupt' },
  { kind: 'resume' },
  { kind: 'retry' },
]

describe('RFC-108 nextTaskStatus — 转移表 oracle 与 allowedFrom 自洽', () => {
  test('property：每个 (from,event) 要么返回 target 要么抛 IllegalTaskTransition，且与 allowedFromForTaskEvent 一致', () => {
    for (const event of EVENTS) {
      const allowed = new Set(allowedFromForTaskEvent(event))
      for (const from of TASK_STATUS) {
        if (allowed.has(from)) {
          expect(nextTaskStatus(from, event)).toBe(targetForTaskEvent(event))
        } else {
          expect(() => nextTaskStatus(from, event)).toThrow(IllegalTaskTransition)
        }
      }
    }
  })

  test('关键真实转移锁定意图（与 resumeTask/cancelTask/reaper 实际语义对齐）', () => {
    // resumeTask: failed/interrupted/awaiting_* → pending
    expect([...allowedFromForTaskEvent({ kind: 'resume' })].sort()).toEqual([
      'awaiting_human',
      'awaiting_review',
      'failed',
      'interrupted',
    ])
    expect(targetForTaskEvent({ kind: 'resume' })).toBe('pending')
    // retryNode: any terminal → pending
    expect([...allowedFromForTaskEvent({ kind: 'retry' })].sort()).toEqual([
      'canceled',
      'done',
      'failed',
      'interrupted',
    ])
    // reaper / shutdown: pending|running → interrupted (awaiting_* NOT reaped)
    expect([...allowedFromForTaskEvent({ kind: 'interrupt' })].sort()).toEqual([
      'pending',
      'running',
    ])
    // scheduler claim: pending → running
    expect(nextTaskStatus('pending', { kind: 'claim' })).toBe('running')
    expect(() => nextTaskStatus('running', { kind: 'claim' })).toThrow(IllegalTaskTransition)
    // complete only from running
    expect(nextTaskStatus('running', { kind: 'complete' })).toBe('done')
  })

  test('terminal 源对 resume/retry 合法（allowTerminal 由 setTaskStatus 把关，非 oracle）', () => {
    // The oracle permits the transition; the terminal-overwrite guard lives in
    // setTaskStatus (allowTerminal escape hatch), not here.
    expect(nextTaskStatus('failed', { kind: 'resume' })).toBe('pending')
    expect(nextTaskStatus('interrupted', { kind: 'resume' })).toBe('pending')
    expect(nextTaskStatus('done', { kind: 'retry' })).toBe('pending')
  })
})

describe('RFC-108 T2 — TERMINAL_TASK_STATUSES 上提 shared', () => {
  test('terminal 集 = done/failed/canceled/interrupted', () => {
    expect([...TERMINAL_TASK_STATUSES].sort()).toEqual([
      'canceled',
      'done',
      'failed',
      'interrupted',
    ])
  })

  test('isTerminalTaskStatus 谓词', () => {
    for (const s of TASK_STATUS) {
      const expected = (['done', 'failed', 'canceled', 'interrupted'] as TaskStatus[]).includes(s)
      expect(isTerminalTaskStatus(s)).toBe(expected)
    }
  })
})
