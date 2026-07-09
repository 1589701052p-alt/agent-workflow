// RFC-138 (design/RFC-138-reassign-to-asker-single-run) — 改派给提问节点只跑一遍。
//
// 回归锁：跨节点反问 designer 条目改派到**该轮提问节点**时，旧行为写 override 会双跑
// （questioner 行恒 mint 续跑 + designer 改派行再 mint 修订 rerun，两 cause 互斥强制串行、
// 同一 Q&A 处理两遍——用户 2026-07-03「怕提问节点收到 2 遍问题」确认成立）。新行为
// collapse：单事务两表 question_scopes_json 翻转 'questioner'（RFC-058 lockstep）+ 删未下发
// designer 行，该题只剩 questioner 行 = 天然一条续跑、单份投递，并顺带脱离整轮单目标 409。
//
//   1. collapse 正路径（AC-1）：designer 行删除、两表 scope 翻转一致（dual-write 锁）、
//      questioner 行逐列不变、返回 'collapsed-to-questioner'。
//   2. golden-lock（AC-4）：改派到第三节点仍写 override、不删行、不碰 scope。
//   3. 边界拒绝（AC-5）：已下发 409（分支前 CAS）；self / questioner 行不触发 collapse。
//   4. 混轮下发（AC-3）：q1 collapse、q2 留设计节点 ⇒ dispatch 无 multi-target 409，
//      设计节点注入只含 q2。
//   5. 单次投递（AC-2）：collapse 后下发 questioner 批 ⇒ 提问节点恰一条
//      cross-clarify-questioner-rerun、注入渲染该题恰一次、全程零 cross-clarify-answer mint。
//   6. 不复活（AC-6）：collapse 后 lazy reconcile（listTaskQuestions）不再生成 designer 行，
//      scope 保持 'questioner'。
//   7. 未答轮不伪造 seal（用户 2026-07-09 repro：改派处理节点后未答问题错误显示「加入待下发」）：
//      一张 UNANSWERED 轮的未 seal designer 行（RFC-140 反向 collapse 的遗留形态）再被改派回
//      提问节点时，幸存 questioner 行必须保持未 seal——旧无条件 `entry.sealedAt ?? now` 会把未答
//      问题标 sealed → 前端 hasStage 门放行「加入待下发」。修复镜像 RFC-140
//      collapseQuestionerEntryToDesigner 的 `status==='answered'` 守卫。

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { monotonicFactory } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  nodeRunOutputs,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { buildClarifyQueueContext } from '../src/services/clarifyQueue'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { listTaskQuestions, reassignTaskQuestion } from '../src/services/taskQuestions'
import { ConflictError } from '../src/util/errors'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const ulid = monotonicFactory()
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const ASKER = 'asker' // cross 轮提问节点（questioner）
const DESIGNER = 'designer' // cross 轮图设计节点（designer 行默认承接）
const OTHER = 'other' // 第三 agent 节点（golden-lock 改派目标）
const CC = 'cc' // cross-clarify 中介节点
const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: ASKER, kind: 'agent-single', agentName: 'agent-asker' } as WorkflowNode,
    { id: DESIGNER, kind: 'agent-single', agentName: 'agent-designer' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: 'agent-other' } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_dataflow',
        source: { nodeId: DESIGNER, portName: 'out' },
        target: { nodeId: ASKER, portName: 'in' },
      },
      // cross-clarify 通道边：assertDesignerReady 经 to_designer 边解析姊妹反问节点。
      {
        id: 'e_cc_designer',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_questioner',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: ASKER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  } as unknown as WorkflowDefinition
}

function mkQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `${id}-title`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

async function seedTask(db: DbClient, taskId: string): Promise<void> {
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc138',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc138',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc138',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: '{}',
    startedAt: Date.now(),
  })
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  over: { status?: string; hasOutput?: boolean } = {},
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: (over.status ?? 'done') as 'done',
    retryIndex: 0,
    iteration: 0,
  })
  if (over.hasOutput) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: id, portName: 'out', content: 'x' })
  }
  return id
}

/** 落一条 answered cross 轮 + lockstep 的 legacy session 行（同 id），返回 {roundId, origin}。 */
async function seedCrossRound(
  db: DbClient,
  taskId: string,
  questions: ClarifyQuestion[],
  opts: { scopesJson?: string | null; status?: 'answered' | 'awaiting_human' } = {},
): Promise<{ roundId: string; origin: string }> {
  const askingRunId = await seedRun(db, taskId, ASKER, { status: 'done' })
  const intRunId = await seedRun(db, taskId, CC, { status: 'done' })
  const roundId = ulid()
  const questionsJson = JSON.stringify(questions)
  const answersJson = JSON.stringify(questions.map((q) => ans(q.id)))
  const status = opts.status ?? 'answered'
  const answeredAt = status === 'answered' ? Date.now() : null
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: 'cross',
    askingNodeId: ASKER,
    askingNodeRunId: askingRunId,
    intermediaryNodeId: CC,
    intermediaryNodeRunId: intRunId,
    targetConsumerNodeId: DESIGNER,
    iteration: 0,
    questionsJson,
    answersJson,
    questionScopesJson: opts.scopesJson ?? null,
    directive: 'continue',
    status,
    answeredAt,
  })
  await db.insert(crossClarifySessions).values({
    id: roundId,
    taskId,
    crossClarifyNodeId: CC,
    crossClarifyNodeRunId: intRunId,
    sourceQuestionerNodeId: ASKER,
    sourceQuestionerNodeRunId: askingRunId,
    targetDesignerNodeId: DESIGNER,
    questionsJson,
    answersJson,
    questionScopesJson: opts.scopesJson ?? null,
    status,
    answeredAt,
  })
  return { roundId, origin: intRunId }
}

interface EntrySeed {
  originNodeRunId: string
  questionId: string
  roleKind: 'self' | 'questioner' | 'designer'
  sourceKind?: 'self' | 'cross'
  defaultTargetNodeId: string | null
  overrideTargetNodeId?: string | null
  /** false = legacy answered 轮懒建行形态（sealed_at NULL，契约 #17）。默认 true。 */
  sealed?: boolean
  dispatchedAt?: number | null
  stagedAt?: number | null
}

async function insertEntry(db: DbClient, taskId: string, e: EntrySeed): Promise<string> {
  const id = ulid()
  await db.insert(taskQuestions).values({
    id,
    taskId,
    originNodeRunId: e.originNodeRunId,
    questionId: e.questionId,
    questionTitle: `${e.questionId}-title`,
    sourceKind: e.sourceKind ?? 'cross',
    roleKind: e.roleKind,
    iteration: 0,
    loopIter: 0,
    defaultTargetNodeId: e.defaultTargetNodeId,
    overrideTargetNodeId: e.overrideTargetNodeId ?? null,
    sealedAt: (e.sealed ?? true) ? Date.now() : null,
    sealedBy: (e.sealed ?? true) ? 'u1' : null,
    dispatchedAt: e.dispatchedAt ?? null,
    dispatchedBy: e.dispatchedAt ? 'u1' : null,
    stagedAt: e.stagedAt ?? null,
    stagedBy: e.stagedAt ? 'u1' : null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

const allEntries = (db: DbClient, taskId: string) =>
  db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))

async function scopesOf(db: DbClient, roundId: string) {
  const round = (
    await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)).limit(1)
  )[0]!
  const session = (
    await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.id, roundId))
      .limit(1)
  )[0]!
  return { round: round.questionScopesJson, session: session.questionScopesJson }
}

beforeEach(() => resetBroadcastersForTests())

describe('RFC-138 collapse 正路径（AC-1 + dual-write 锁）', () => {
  test('designer 行改派到提问节点 → 行删除、两表 scope 翻转一致、questioner 行逐列不变', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      stagedAt: Date.now(), // staged 覆盖层随行删除（用户显式操作，丢弃是本意）
    })
    const questionerBefore = (await allEntries(db, taskId)).find((e) => e.id === questionerId)!

    const action = await reassignTaskQuestion(db, designerId, ASKER, actor)

    expect(action).toBe('collapsed-to-questioner')
    const after = await allEntries(db, taskId)
    expect(after.find((e) => e.id === designerId)).toBeUndefined()
    expect(after.filter((e) => e.roleKind === 'designer').length).toBe(0)
    // questioner 行逐列不变（collapse 不在残留行上伪造改派戳——D4）。
    const questionerAfter = after.find((e) => e.id === questionerId)!
    expect(questionerAfter).toEqual(questionerBefore)
    // 两表 scope 翻转且 lockstep 相等（RFC-058 dual-write 锁）。
    const scopes = await scopesOf(db, roundId)
    expect(scopes.round).toBe(scopes.session)
    expect(JSON.parse(scopes.round ?? '{}')).toEqual({ q1: 'questioner' })
  })

  // RFC-140 遗留修复（用户 2026-07-05 裁决）— 幸存 questioner 行三分支（镜像 RFC-140 W1）：
  // 塌缩语义「该题让提问节点自己消化」要求幸存行真的指回提问节点，旧第三节点 override 不得残留。
  test('RFC-140 遗留：幸存 questioner 行带旧第三节点 override（未下发）→ 塌缩后归一化清空 + 审计戳', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: OTHER, // 旧改派残留
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    expect(await reassignTaskQuestion(db, designerId, ASKER, actor)).toBe('collapsed-to-questioner')
    const survivor = (await allEntries(db, taskId)).find((e) => e.id === questionerId)!
    expect(survivor.overrideTargetNodeId).toBeNull() // effective 回落提问节点
    expect(survivor.lastReassignedBy).toBe(actor.userId)
    expect(survivor.lastReassignedAt).not.toBeNull()
  })

  test('RFC-140 遗留：幸存 questioner 行已下发且 effective==提问节点 → 塌缩照做、幸存行零改动', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const dispatchedAt = Date.now() - 1000
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      dispatchedAt,
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    const before = (await allEntries(db, taskId)).find((e) => e.id === questionerId)!
    expect(await reassignTaskQuestion(db, designerId, ASKER, actor)).toBe('collapsed-to-questioner')
    const survivor = (await allEntries(db, taskId)).find((e) => e.id === questionerId)!
    expect(survivor).toEqual(before) // 零改动（义务已在正轨——D6 镜像）
    expect(JSON.parse((await scopesOf(db, roundId)).round ?? '{}')).toEqual({ q1: 'questioner' })
  })

  test('RFC-140 遗留：幸存 questioner 行已下发且 effective==第三节点 → 409 拒塌缩、designer 行与 scope 均不动', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      overrideTargetNodeId: OTHER,
      dispatchedAt: Date.now(), // 已在第三节点上执行
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    let caught: unknown
    try {
      await reassignTaskQuestion(db, designerId, ASKER, actor)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ConflictError)
    expect((caught as ConflictError).code).toBe('task-question-already-dispatched')
    const after = await allEntries(db, taskId)
    expect(after.find((e) => e.id === designerId)).toBeDefined() // 未删
    expect((await scopesOf(db, roundId)).round).toBeNull() // scope 未翻转（零部分写）
  })

  // Codex impl-gate P2 — legacy answered 轮懒建行（sealed_at NULL）：designer 行是原 park 锚，
  // 删除后幸存 questioner 行若仍 NULL 会被 self/q park 源（sealed_at IS NOT NULL）滤掉 →
  // 调度不再驻留、该题续跑永不 mint。collapse 同事务补 seal 行戳（镜像 RFC-134 §3.1）。
  test('legacy 懒建行：collapse 给幸存 questioner 行补 seal 行戳（sealed_by 保持 NULL）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      sealed: false,
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      sealed: false,
    })

    await reassignTaskQuestion(db, designerId, ASKER, actor)

    const questioner = (await allEntries(db, taskId)).find((e) => e.id === questionerId)!
    expect(questioner.sealedAt).not.toBeNull() // park/渲染资格保住
    expect(questioner.sealedBy).toBeNull() // 「answered 轮证据落戳」审计语义（非人工 seal）
  })

  // Codex impl-gate P2 第二轮 — 异常形态：questioner 行未物化（只有 designer 行）。collapse
  // 事务内 insert-if-missing 补建幸存行（带 seal 戳），不依赖事后 reconcile（那会建出
  // sealed_at=NULL 的行、照样被 park 源滤掉）。
  test('questioner 行缺席：collapse 事务内补建幸存行（带 seal 戳、目标=提问节点）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      sealed: false,
    })

    await reassignTaskQuestion(db, designerId, ASKER, actor)

    const rows = await allEntries(db, taskId)
    expect(rows.filter((e) => e.roleKind === 'designer').length).toBe(0)
    const questioner = rows.find((e) => e.roleKind === 'questioner')!
    expect(questioner).toBeDefined()
    expect(questioner.questionId).toBe('q1')
    expect(questioner.sourceKind).toBe('cross')
    expect(questioner.defaultTargetNodeId).toBe(ASKER)
    expect(questioner.sealedAt).not.toBeNull()
    expect(questioner.sealedBy).toBeNull()
  })

  test('merge-write：既有 scope 键不丢（tx 内重读 round 再合并）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1'), mkQ('q2')], {
      scopesJson: JSON.stringify({ q2: 'designer' }),
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    await reassignTaskQuestion(db, designerId, ASKER, actor)
    const scopes = await scopesOf(db, roundId)
    expect(JSON.parse(scopes.round ?? '{}')).toEqual({ q1: 'questioner', q2: 'designer' })
    expect(scopes.round).toBe(scopes.session)
  })
})

describe('RFC-138 golden-lock（AC-4）与边界拒绝（AC-5）', () => {
  test('改派到第三节点仍走 override：写 override、不删行、两表 scope 不动', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })

    const action = await reassignTaskQuestion(db, designerId, OTHER, actor)

    expect(action).toBe('override')
    const row = (await allEntries(db, taskId)).find((e) => e.id === designerId)!
    expect(row.overrideTargetNodeId).toBe(OTHER)
    expect(row.lastReassignedBy).toBe('u1')
    const scopes = await scopesOf(db, roundId)
    expect(scopes.round).toBeNull()
    expect(scopes.session).toBeNull()
  })

  test('已下发 designer 行改派到提问节点 → 409，行与 scope 均不动（分支内 CAS）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      dispatchedAt: Date.now(),
    })

    let err: unknown
    try {
      await reassignTaskQuestion(db, designerId, ASKER, actor)
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe('task-question-already-dispatched')
    expect((await allEntries(db, taskId)).find((e) => e.id === designerId)).toBeDefined()
    const scopes = await scopesOf(db, roundId)
    expect(scopes.round).toBeNull()
    expect(scopes.session).toBeNull()
  })

  test('questioner 行改派到提问节点（=自身默认）不触发 collapse，走 override 路径', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
    })

    const action = await reassignTaskQuestion(db, questionerId, ASKER, actor)

    expect(action).toBe('override')
    const row = (await allEntries(db, taskId)).find((e) => e.id === questionerId)!
    expect(row.overrideTargetNodeId).toBe(ASKER)
    expect((await scopesOf(db, roundId)).round).toBeNull()
  })
})

describe('RFC-138 混轮下发（AC-3）', () => {
  test('q1 collapse、q2 留设计节点 → 下发无 multi-target 409，设计节点注入只含 q2', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    await seedRun(db, taskId, DESIGNER, { hasOutput: true }) // frontier 安全门：目标须有过 run
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1'), mkQ('q2')])
    for (const qid of ['q1', 'q2']) {
      await insertEntry(db, taskId, {
        originNodeRunId: origin,
        questionId: qid,
        roleKind: 'questioner',
        defaultTargetNodeId: ASKER,
      })
    }
    const d1 = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    const d2 = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q2',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })

    // 旧行为对照：q1 改派 override=ASKER + q2 默认 DESIGNER ⇒ 整轮单目标 409。
    // collapse 后 q1 的 designer 行不存在 ⇒ 下发 q2 畅通。
    await reassignTaskQuestion(db, d1, ASKER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [d2], actor)

    expect(result.dispatchedEntryIds).toEqual([d2])
    expect(result.reruns.map((r) => r.targetNodeId)).toEqual([DESIGNER])
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: DESIGNER,
      dispatchedRunId: result.reruns[0]!.nodeRunId,
      iteration: 0,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain('q2-title')
    expect(ctx!.block).not.toContain('q1-title')
  })
})

describe('RFC-138 单次投递（AC-2）', () => {
  test('collapse 后下发 → 提问节点恰一条 questioner 续跑、该题渲染恰一次、零 cross-clarify-answer', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
    })
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })

    await reassignTaskQuestion(db, designerId, ASKER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [questionerId], actor)

    // 恰一条 rerun、在提问节点、cause 为 questioner 续跑；全任务零 cross-clarify-answer。
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]!.targetNodeId).toBe(ASKER)
    const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const minted = runs.find((r) => r.id === result.reruns[0]!.nodeRunId)!
    expect(minted.rerunCause).toBe('cross-clarify-questioner-rerun')
    expect(runs.filter((r) => r.rerunCause === 'cross-clarify-answer').length).toBe(0)
    // 注入渲染：该题恰出现一次（单份投递）。
    const ctx = await buildClarifyQueueContext({
      db,
      definition: liveDef(),
      taskId,
      consumerNodeId: ASKER,
      dispatchedRunId: minted.id,
      iteration: 0,
    })
    expect(ctx).toBeDefined()
    const occurrences = ctx!.block.split('q1-title').length - 1
    expect(occurrences).toBe(1)
  })
})

describe('RFC-138 D6 与已下发反问者续跑相遇（Codex 实现门 P1 裁决锁）', () => {
  // quick 路径常态：答完即自动下发反问者批——续跑已带该题答案跑过。此时把 designer 卡改派
  // 给提问节点 ⇒ 零新增 mint 是**有意行为**（补 mint = 复活双跑）；终态与「答题时就选
  // scope=questioner」同形，questioner 卡照常走确认闭环，无悬挂 pending。
  test('questioner 行已下发已消费 → collapse 成功、零新 node_run、看板无悬挂 designer 卡', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    // 已消费形态：questioner 行 dispatched + 绑定到一条 done+output 的续跑。
    const continuationRunId = await seedRun(db, taskId, ASKER, {
      status: 'done',
      hasOutput: true,
    })
    await db
      .update(nodeRuns)
      .set({ rerunCause: 'cross-clarify-questioner-rerun' })
      .where(eq(nodeRuns.id, continuationRunId))
    const questionerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'questioner',
      defaultTargetNodeId: ASKER,
      dispatchedAt: Date.now(),
    })
    await db
      .update(taskQuestions)
      .set({ triggerRunId: continuationRunId })
      .where(eq(taskQuestions.id, questionerId))
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    const runsBefore = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length

    const action = await reassignTaskQuestion(db, designerId, ASKER, actor)

    expect(action).toBe('collapsed-to-questioner')
    // 零新增 mint（有意：续跑已带答案处理过，补 mint 即双跑）。
    const runsAfter = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).length
    expect(runsAfter).toBe(runsBefore)
    // 已下发的 questioner 行不被 upsert/补戳路径改动（dispatched 行原样保留）。
    const rows = await allEntries(db, taskId)
    expect(rows.filter((e) => e.roleKind === 'designer').length).toBe(0)
    const questioner = rows.find((e) => e.id === questionerId)!
    expect(questioner.dispatchedAt).not.toBeNull()
    expect(questioner.triggerRunId).toBe(continuationRunId)
    // 看板一致性：该题只剩 questioner 卡且已达可确认相位（无悬挂 pending designer 卡）。
    const dtos = await listTaskQuestions(db, taskId)
    const q1 = dtos.filter((d) => d.questionId === 'q1')
    expect(q1.length).toBe(1)
    expect(q1[0]!.roleKind).toBe('questioner')
    expect(q1[0]!.phase).toBe('awaiting_confirm')
  })
})

describe('RFC-138 不复活（AC-6）', () => {
  test('collapse 后 lazy reconcile 不再生成该题 designer 行，scope 保持 questioner', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { roundId, origin } = await seedCrossRound(db, taskId, [mkQ('q1')])
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
    })
    await reassignTaskQuestion(db, designerId, ASKER, actor)

    // listTaskQuestions 内部对每轮跑 reconcileTaskQuestionsForRound（lazy reconcile）。
    const dtos = await listTaskQuestions(db, taskId)

    expect(dtos.filter((d) => d.roleKind === 'designer').length).toBe(0)
    // questioner 行由 reconcile 补建（恒有）——该题唯一承接。
    expect(dtos.filter((d) => d.questionId === 'q1' && d.roleKind === 'questioner').length).toBe(1)
    const rows = await db
      .select()
      .from(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    expect(rows.length).toBe(0)
    expect(JSON.parse((await scopesOf(db, roundId)).round ?? '{}')).toEqual({ q1: 'questioner' })
  })
})

describe('RFC-138 未答轮不伪造 seal（用户 2026-07-09 repro）', () => {
  // 根因：collapseDesignerEntryToQuestioner 的 seal 归一化旧为无条件 `entry.sealedAt ?? now`。
  // designer 行本应 reconcile 于 seal 之后，但 RFC-140 反向 collapse 会为**未答**问题
  // insert 一张未 seal 的 designer 行——它再被改派回提问节点走到这里时，`?? now` 会把未答问题
  // 标 sealed，DTO sealed=true → 前端 hasStage 门（(pending|staged) && (staged||sealed)）放行
  // 「加入待下发」。修复：只有 answered 轮才回落 now（镜像 RFC-140
  // collapseQuestionerEntryToDesigner 的守卫），否则原样继承（NULL 让幸存行保持未 seal）。
  test('未答轮的未 seal designer 行 collapse 回提问节点 → 幸存 questioner 行保持未 seal（不显示加入待下发）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = `t_${ulid()}`
    await seedTask(db, taskId)
    const { origin } = await seedCrossRound(db, taskId, [mkQ('q1')], {
      status: 'awaiting_human',
    })
    // RFC-140 反向 collapse 遗留：未答问题被改派 questioner→designer 后留下的未 seal designer 行。
    const designerId = await insertEntry(db, taskId, {
      originNodeRunId: origin,
      questionId: 'q1',
      roleKind: 'designer',
      defaultTargetNodeId: DESIGNER,
      sealed: false,
    })

    const action = await reassignTaskQuestion(db, designerId, ASKER, actor)

    expect(action).toBe('collapsed-to-questioner')
    // 核心断言：未答轮绝不伪造 seal → 幸存 questioner 行 sealedAt 保持 NULL。
    const questioner = (await allEntries(db, taskId)).find((e) => e.roleKind === 'questioner')!
    expect(questioner).toBeDefined()
    expect(questioner.sealedAt).toBeNull()
    // DTO 层：sealed=false → 前端 hasStage 门不显示「加入待下发」。
    const dtos = await listTaskQuestions(db, taskId)
    const q1 = dtos.filter((d) => d.questionId === 'q1')
    expect(q1.length).toBe(1)
    expect(q1[0]!.roleKind).toBe('questioner')
    expect(q1[0]!.sealed).toBe(false)
  })
})
