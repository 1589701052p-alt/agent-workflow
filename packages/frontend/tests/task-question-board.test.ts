// RFC-163 — `groupBoardEntries` 分组逐格锁（design §5，case 1-6；case 7 filter 属组件层）。
//
// 为什么这条测试存在（回归防护）：看板「下发前一问一卡、下发后各处理节点拆开」的单一事实源。改派后
// 提问条目 + 未下发 designer 必须收拢成一张卡（case 2），一旦下发就拆开（case 3）；混态不跨列拼
// （case 4，钉死 design §1 不变式的降级兜底）；manual 不聚合（case 5）；组内混相位保守落 pending
// 不丢卡（case 6）。任何 refactor 破坏这些立即变红。

import { describe, expect, test } from 'vitest'
import { groupBoardEntries } from '../src/lib/task-question-board'
import type { TaskQuestionEntry, TaskQuestionPhase } from '../src/components/tasks/TaskQuestionList'

function mk(over: Partial<TaskQuestionEntry> & { id: string }): TaskQuestionEntry {
  return {
    questionId: 'q1',
    questionTitle: 'Redis 还是 Memcached?',
    originNodeRunId: 'nr-1',
    sourceKind: 'self',
    roleKind: 'self',
    sourceNodeId: 'coder',
    defaultTargetNodeId: 'coder',
    overrideTargetNodeId: null,
    effectiveTargetNodeId: 'coder',
    phase: 'pending' as TaskQuestionPhase,
    confirmation: 'open',
    staged: false,
    autoDispatchDeferred: false,
    sealed: false,
    answerSummary: null,
    ...over,
  }
}

describe('RFC-163 groupBoardEntries', () => {
  test('case 1 — 单提问条目（无改派）→ 1 卡、grouped=false、handlers=[self]', () => {
    const cards = groupBoardEntries([mk({ id: 'a', roleKind: 'self', phase: 'pending' })])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.grouped).toBe(false)
    expect(cards[0]!.handlers.map((h) => h.entry.id)).toEqual(['a'])
    expect(cards[0]!.phase).toBe('pending')
  })

  test('case 2 — 提问 + 未下发 designer（改派后）→ 1 卡、grouped=true、self 在前 designer 在后', () => {
    // 故意 designer 在前，验证排序把 self 提前。
    const cards = groupBoardEntries([
      mk({ id: 'd', roleKind: 'designer', effectiveTargetNodeId: 'reviewer', phase: 'pending' }),
      mk({ id: 's', roleKind: 'self', phase: 'pending' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.grouped).toBe(true)
    expect(cards[0]!.handlers.map((h) => h.entry.id)).toEqual(['s', 'd']) // 提问在前
    expect(cards[0]!.key).toBe('q:nr-1:q1')
  })

  test('case 3 — 提问 + designer 均已下发 → 2 卡（各 grouped=false）', () => {
    const cards = groupBoardEntries([
      mk({ id: 's', roleKind: 'self', phase: 'processing' }),
      mk({ id: 'd', roleKind: 'designer', effectiveTargetNodeId: 'reviewer', phase: 'processing' }),
    ])
    expect(cards).toHaveLength(2)
    expect(cards.every((c) => !c.grouped)).toBe(true)
    expect(cards.map((c) => c.handlers[0]!.entry.id).sort()).toEqual(['d', 's'])
  })

  test('case 4 — 提问未下发 + designer 已下发（混态）→ 未下发单卡 + 已下发单卡，不跨列拼', () => {
    const cards = groupBoardEntries([
      mk({ id: 's', roleKind: 'self', phase: 'pending' }),
      mk({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'reviewer',
        phase: 'awaiting_confirm',
      }),
    ])
    expect(cards).toHaveLength(2)
    const pendingCard = cards.find((c) => c.phase === 'pending')!
    const doneCard = cards.find((c) => c.phase === 'awaiting_confirm')!
    expect(pendingCard.handlers.map((h) => h.entry.id)).toEqual(['s']) // 未下发提问单独，不含 designer
    expect(doneCard.handlers.map((h) => h.entry.id)).toEqual(['d'])
    expect(pendingCard.grouped).toBe(false)
  })

  test('case 5 — manual ×2 → 2 卡（各自，不聚合）', () => {
    const cards = groupBoardEntries([
      mk({
        id: 'm1',
        roleKind: 'designer',
        sourceKind: 'manual',
        originNodeRunId: null,
        phase: 'pending',
      }),
      mk({
        id: 'm2',
        roleKind: 'designer',
        sourceKind: 'manual',
        originNodeRunId: null,
        phase: 'pending',
      }),
    ])
    expect(cards).toHaveLength(2)
    expect(cards.map((c) => c.key)).toEqual(['e:m1', 'e:m2'])
  })

  // 用户 2026-07-10 bug 的正向锁：在待下发里改派后（后端 designer 继承 staged），组内全 staged
  // ⇒ 卡留在**待下发**列（不再落回待指派）。
  test('全 staged 组 → 卡 phase=staged（在待下发改派后整卡留在待下发）', () => {
    const cards = groupBoardEntries([
      mk({ id: 's', roleKind: 'self', phase: 'staged', staged: true, sealed: true }),
      mk({
        id: 'd',
        roleKind: 'designer',
        effectiveTargetNodeId: 'reviewer',
        phase: 'staged',
        staged: true,
        sealed: true,
      }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.phase).toBe('staged')
    expect(cards[0]!.grouped).toBe(true)
  })

  test('case 6 — 组内混 pending+staged（防御）→ 卡落 pending、不丢 handler', () => {
    const cards = groupBoardEntries([
      mk({ id: 's', roleKind: 'self', phase: 'staged', staged: true }),
      mk({ id: 'd', roleKind: 'designer', effectiveTargetNodeId: 'reviewer', phase: 'pending' }),
    ])
    expect(cards).toHaveLength(1)
    expect(cards[0]!.phase).toBe('pending') // 保守
    expect(cards[0]!.handlers.map((h) => h.entry.id)).toEqual(['s', 'd']) // 不丢 handler
  })

  test('两个不同问题各自成卡；卡序 = 首现序', () => {
    const cards = groupBoardEntries([
      mk({ id: 'a', questionId: 'qA', originNodeRunId: 'nrA', phase: 'pending' }),
      mk({ id: 'b', questionId: 'qB', originNodeRunId: 'nrB', phase: 'pending' }),
    ])
    expect(cards.map((c) => c.questionId)).toEqual(['qA', 'qB'])
  })
})
