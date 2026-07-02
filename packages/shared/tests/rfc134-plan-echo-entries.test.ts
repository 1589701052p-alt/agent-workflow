// RFC-134 改派回执 — planEchoEntries 纯 oracle 锁。
//
// 锁定通用不变量的判定式（design/RFC-134-reassign-asker-echo/design.md §2.3）：
// 凡有效承接 ≠ 提问节点的 self/questioner 下发条目，产一条 echo 回执（目标=提问节点）；
// 兄弟跳过 = 交付感知（R3-F6：已下发 ∨ 同批 stamp 才算交付）+ 可渲染性（R4-F8：历史
// sealedAt-NULL 懒建行不算交付）+ stampedIds 单值化（R6-F11：同批行经 seal 归一化必可
// 渲染，历史/同批两分支**分开锁**）；sealedAt 兜底在纯函数内定值（R7-F12：batchTimestamp
// 显式入参）。任何 refactor 让某条变红 = 回执投递保证被破坏。

import { describe, expect, test } from 'bun:test'
import {
  echoSiblingKey,
  planEchoEntries,
  type EchoPlanInputRow,
  type EchoSiblingSnapshot,
  type PlanEchoEntriesInput,
} from '../src/task-questions'

const ASKER = 'node_asker'
const OTHER = 'node_other'
const ORIGIN = '01ORIGIN'
const BATCH_TS = 1_751_400_000_000

function row(over: Partial<EchoPlanInputRow> = {}): EchoPlanInputRow {
  return {
    id: 'q_row_1',
    roleKind: 'self',
    sourceKind: 'self',
    questionId: 'q1',
    questionTitle: 'Q1?',
    originNodeRunId: ORIGIN,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: ASKER,
    overrideTargetNodeId: OTHER,
    sealedAt: 111,
    ...over,
  }
}

function sib(over: Partial<EchoSiblingSnapshot> = {}): EchoSiblingSnapshot {
  return {
    id: 'q_sib_1',
    defaultTargetNodeId: OTHER,
    overrideTargetNodeId: ASKER,
    dispatchedAt: 222,
    sealedAt: 333,
    sourceKind: 'cross',
    ...over,
  }
}

function plan(
  batch: EchoPlanInputRow[],
  siblings: EchoSiblingSnapshot[] = [],
  stampedIds: Iterable<string> = batch.map((b) => b.id),
) {
  const siblingsByQuestion = new Map<string, EchoSiblingSnapshot[]>()
  for (const b of batch) {
    const key = echoSiblingKey(b.originNodeRunId, b.questionId)
    if (!siblingsByQuestion.has(key)) siblingsByQuestion.set(key, siblings)
  }
  const input: PlanEchoEntriesInput = {
    batch,
    siblingsByQuestion,
    stampedIds: new Set(stampedIds),
    batchTimestamp: BATCH_TS,
  }
  return planEchoEntries(input)
}

describe('RFC-134 planEchoEntries — 产出条件', () => {
  test('self 改派 → 1 条 echo（目标=提问节点，字段快照齐全）', () => {
    const out = plan([row()])
    expect(out).toEqual([
      {
        originNodeRunId: ORIGIN,
        questionId: 'q1',
        questionTitle: 'Q1?',
        sourceKind: 'self',
        targetNodeId: ASKER,
        iteration: 0,
        loopIter: 0,
        sealedAt: 111,
      },
    ])
  })

  test('questioner 改派 → 1 条 echo（sourceKind=cross 透传）', () => {
    const out = plan([row({ roleKind: 'questioner', sourceKind: 'cross' })])
    expect(out).toHaveLength(1)
    expect(out[0]!.sourceKind).toBe('cross')
    expect(out[0]!.targetNodeId).toBe(ASKER)
  })

  test('override == default（视同未改派）→ 0（黄金锁）', () => {
    expect(plan([row({ overrideTargetNodeId: ASKER })])).toHaveLength(0)
  })

  test('override 空 → 0（黄金锁：无改派批次零 echo）', () => {
    expect(plan([row({ overrideTargetNodeId: null })])).toHaveLength(0)
  })

  test('designer / manual / echo 角色 → 0（designer 由 questioner 条目天然满足；echo 不自繁殖）', () => {
    expect(plan([row({ roleKind: 'designer', sourceKind: 'cross' })])).toHaveLength(0)
    expect(plan([row({ roleKind: 'designer', sourceKind: 'manual' })])).toHaveLength(0)
    expect(plan([row({ roleKind: 'echo' })])).toHaveLength(0)
    expect(plan([row({ sourceKind: 'manual' })])).toHaveLength(0) // 防御：manual 伪装 self
  })

  test('default（提问节点）为空 → 0（无处投递）', () => {
    expect(plan([row({ defaultTargetNodeId: null })])).toHaveLength(0)
  })

  test('同批同 (origin, question) 防御性去重 → 只产 1 条', () => {
    const out = plan([row({ id: 'a' }), row({ id: 'b' })])
    expect(out).toHaveLength(1)
  })

  test('sealedAt 定值：源非空继承；源 NULL 取 batchTimestamp（R7-F12，恒可渲染）', () => {
    expect(plan([row({ sealedAt: 555 })])[0]!.sealedAt).toBe(555)
    expect(plan([row({ sealedAt: null })])[0]!.sealedAt).toBe(BATCH_TS)
  })
})

describe('RFC-134 planEchoEntries — 兄弟跳过（交付感知 + 可渲染性 + 单值化）', () => {
  test('兄弟已下发且 sealed、指向提问节点 → 跳过（交付已保证）', () => {
    expect(plan([row()], [sib()])).toHaveLength(0)
  })

  test('兄弟 default 即提问节点（未改派形态）且已下发 sealed → 跳过', () => {
    expect(
      plan([row()], [sib({ defaultTargetNodeId: ASKER, overrideTargetNodeId: null })]),
    ).toHaveLength(0)
  })

  test('兄弟指向提问节点但未下发且不在本批 → 仍产 echo（承诺≠交付，R3-F6）', () => {
    expect(plan([row()], [sib({ dispatchedAt: null })])).toHaveLength(1)
  })

  test('历史已下发（∉ stampedIds）但 sealedAt NULL 的兄弟 → 仍产 echo（已下发≠可渲染，R4-F8）', () => {
    expect(plan([row()], [sib({ sealedAt: null })])).toHaveLength(1)
  })

  test('同批 stamped 且 sealedAt NULL 的兄弟 → 跳过（归一化后必可渲染，R6-F11——与历史分支分开锁）', () => {
    const sibling = sib({ id: 'sib_in_batch', dispatchedAt: null, sealedAt: null })
    const candidate = row()
    expect(plan([candidate], [sibling], [candidate.id, 'sib_in_batch'])).toHaveLength(0)
  })

  test('兄弟指向别的节点（≠提问节点）→ 不构成交付、仍产 echo', () => {
    expect(plan([row()], [sib({ overrideTargetNodeId: 'node_third' })])).toHaveLength(1)
  })

  test('候选行自身在兄弟快照里出现（同 id）→ 不把自己当交付兄弟', () => {
    const candidate = row()
    const selfSnapshot = sib({
      id: candidate.id,
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: ASKER,
    })
    expect(plan([candidate], [selfSnapshot])).toHaveLength(1)
  })
})
