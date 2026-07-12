// RFC-163 — 反问看板卡分组的单一事实源（纯函数）。
//
// 用户 2026-07-10：改派处理节点时，「下发前一问一卡，下发后各处理节点拆开」。RFC-162 归一后一条
// clarify 问题默认挂一个处理条目（提问节点 self/questioner）；「让上游改」= 人工改派增一条
// `designer` 处理条目、并保留提问条目（提问节点必然重跑，删不得）。当前看板一条目一卡 ⇒ 改派后立刻
// 两张卡，像「凭空多了个节点」。本函数把**未下发**的同问题条目收拢成一张卡（handler 行列表），**已
// 下发**条目各自单卡（独立追踪/确认）。
//
// 关键不变式（design §1）：一张未下发组卡的 handler **同为未下发** ⇒ 恒在同一列；改派只在下发前可行
// （RFC-163 后端 asker-dispatched 守卫）+ 整组一起下发 ⇒ 不会「一半下发一半没」跨列分裂。即便被绕过
// 出现混态，case-4 也不崩：已下发提问条目单卡 + 未下发 designer 单卡，各在各列、不跨列拼。

import type { TaskQuestionEntry, TaskQuestionPhase } from '@/components/tasks/TaskQuestionList'

/** 组内一行处理节点（承载原条目，供渲染 target/相位/角色 + 卡级动作取 id）。 */
export interface BoardHandlerRow {
  entry: TaskQuestionEntry
}

/** 看板一张卡：下发前可含 >1 handler（提问节点 + 增派上游/下游），下发后恒 =1。 */
export interface BoardCard {
  /** 稳定 key（分组卡 = `q:origin:question`；单条目卡 = `e:id`）。 */
  key: string
  questionTitle: string
  originNodeRunId: string | null
  questionId: string
  /** 该卡所在列。 */
  phase: TaskQuestionPhase
  /** 保序：提问节点条目（self/questioner）在前、designer 在后。 */
  handlers: BoardHandlerRow[]
  /** handlers.length > 1（渲染/测试区分分组卡 vs 单卡）。 */
  grouped: boolean
}

const UNDISPATCHED: ReadonlySet<TaskQuestionPhase> = new Set<TaskQuestionPhase>([
  'pending',
  'staged',
])

/** 组内排序权重：提问节点（self/questioner）在前，designer 在后；同权重保持原序（稳定）。 */
function roleRank(entry: TaskQuestionEntry): number {
  return entry.roleKind === 'designer' ? 1 : 0
}

/** 一张未下发组卡的相位：任一 handler 为 `pending` ⇒ 卡 `pending`（保守、防御混态），否则全 `staged`
 *  ⇒ 卡 `staged`。组级 stage（design §3）保证常态下整组同步、不混。 */
function groupPhase(entries: readonly TaskQuestionEntry[]): TaskQuestionPhase {
  return entries.some((e) => e.phase === 'pending') ? 'pending' : 'staged'
}

/**
 * 把条目聚合成看板卡（design §1 规则的形式化）：
 *  - **未下发** clarify 条目（`phase ∈ {pending,staged}` 且 `originNodeRunId !== null`）：按
 *    `(originNodeRunId, questionId)` 聚合成一张卡。
 *  - **已下发**条目 / **manual**（`originNodeRunId === null`）：各自单卡（不与任何条目聚合）。
 *  - handler 保序（提问节点在前、designer 在后）；卡相位见 {@link groupPhase}；卡序 = 各组首个条目
 *    在输入里的首现序（稳定）。
 */
export function groupBoardEntries(entries: readonly TaskQuestionEntry[]): BoardCard[] {
  const groups = new Map<string, TaskQuestionEntry[]>()
  const order: string[] = []
  for (const e of entries) {
    // 仅「未下发 + 有 clarify round」的条目可聚合；已下发条目与 manual（无 round）各自单卡。
    const groupable = UNDISPATCHED.has(e.phase) && e.originNodeRunId !== null
    const key = groupable ? `q:${e.originNodeRunId}:${e.questionId}` : `e:${e.id}`
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(e)
    } else {
      groups.set(key, [e])
      order.push(key)
    }
  }
  return order.map((key) => {
    const es = groups.get(key)!
    // stable sort：roleRank 升序，同权重保持原插入序。
    const sorted = es
      .map((entry, i) => ({ entry, i }))
      .sort((a, b) => roleRank(a.entry) - roleRank(b.entry) || a.i - b.i)
      .map((x) => x.entry)
    const rep = sorted[0]!
    const phase = sorted.length === 1 ? rep.phase : groupPhase(sorted)
    return {
      key,
      questionTitle: rep.questionTitle,
      originNodeRunId: rep.originNodeRunId,
      questionId: rep.questionId,
      phase,
      handlers: sorted.map((entry) => ({ entry })),
      grouped: sorted.length > 1,
    }
  })
}
