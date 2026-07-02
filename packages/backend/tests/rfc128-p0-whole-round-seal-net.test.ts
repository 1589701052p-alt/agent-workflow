// RFC-128 P0 net — 整轮 seal 全链路回归网（纯测试，零生产改动）。
//
// 背景：RFC-128 P1+ 把 clarify「整轮一次 seal + 整轮一条续跑」改造成 per-question
// 逐题 seal（task_questions.sealed_at + reconcile 逐题门控 + self/questioner 逐题
// 重跑）。本文件按 [hotspot-fortify-refactor] 手法「先有网再动刀」：把当前「整轮
// seal」现状钉死，让 P1+ 的逐题改造一旦破坏现状立刻变红。
//
// 这里只补「现状缺口」——即既有测试 *没有* 显式断言的整轮不变量；已被现有测试锁住
// 的部分只在那些文件加注释指回本网（见各 describe 顶部的「现有覆盖」说明）。任何这里
// 的断言变红，都意味着 P1+ 改动了整轮契约——必须确认那是 RFC-128 有意的逐题改造、并
// 把对应锁迁移到逐题语义，而不是「放松断言让它过」。
//
// ── 5 条现状 × 现有覆盖映射（详见各 describe）────────────────────────────────
//   #1 self 单 rerun        — clarify-service.test.ts 锁了「rerun 存在/retryIndex=0/
//                             clarify done」；本网补「恰好一条 cause='clarify-answer'
//                             续跑 + 整轮 seal 一次性 + sealAnswersServerSide 空数组
//                             返回 [] 不抛错」。
//   #2 cross questioner cascade — cross-clarify-service.test.ts 锁了 stop/continue 路径
//                             + buildExternalFeedbackContext；本网补「恰好一条
//                             cause='cross-clarify-questioner-rerun' + designer 整轮承接」。
//   #3 §18 deferred 部分下发 — rfc120-deferred-dispatch.test.ts 已全量锁（CAS 防重 /
//                             一节点一条 frontier rerun / 部分下发）——本网只在该文件
//                             加注释，不重复。
//   #4 RFC-126 failed→resume — cross-clarify-service.test.ts「RFC-125 follow-up」已锁
//                             ——本网只在该文件加注释，不重复。
//   #5 RFC-070 整轮 aging    — rfc070-aging-stamp-behavior.test.ts 锁了 stamp 写入；
//                             本网补 resolveTriggerForEntry 的「整轮 seal 门控」纯预言
//                             （round 非 answered → 无 trigger；role→消费戳列映射）。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  createClarifySession,
  sealAnswersServerSide,
  submitClarifyAnswers,
} from '../src/services/clarify'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { resolveTriggerForEntry } from '../src/services/taskQuestions'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

// ---------------------------------------------------------------------------
// shared fixtures
// ---------------------------------------------------------------------------

function makeQ(id: string, title: string): ClarifyQuestion {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string, idx = 0): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [idx], selectedOptionLabels: [], customText: '' }
}

// ---------------------------------------------------------------------------
// #1 — self clarify：整轮 seal + 恰好一条 'clarify-answer' 续跑
//
// 现有覆盖（clarify-service.test.ts `describe('submitClarifyAnswers')` :254）锁了
// rerun 存在 / retryIndex=0 / reviewIteration passthrough / clarify done / shard
// passthrough，以及 `describe('sealAnswersServerSide')` :225 的 forgery + drop。
// 它 *没有* 断言：① 一轮恰好一条续跑、② 续跑 cause='clarify-answer'、③ 整轮答案一次
// 性 seal、④ 空数组的 seal 现状。这四条正是 P1（T3 逐题 merge / T4 仅全 seal 翻 answered）
// 与 P5（self 逐题重跑→多条续跑）会破坏的整轮不变量，故在此补锁。
// ---------------------------------------------------------------------------

function selfClarifyDef(): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'clarify1', portName: 'questions' },
      },
      {
        id: 'e2',
        source: { nodeId: 'clarify1', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

async function seedSelfTask(db: DbClient): Promise<{ taskId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = selfClarifyDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p0/repo',
    worktreePath: '', // empty disables rollback path → hermetic
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId }
}

describe('RFC-128 P0 net — 整轮 seal 现状锁 #1: self clarify 单 rerun', () => {
  test('sealAnswersServerSide 现状：空数组返回 [] 不抛错（P1 T3 逐题 merge 勿误以为现状是「空数组抛错」）', () => {
    // design.md §1 引用「:1014 空数组直接抛错」是基于过期 doc 注释——实际 :1014 只在
    // 非数组时抛 clarify-answers-not-array，空数组 [] 走 Array.isArray 为真→直接返回 []。
    // P1 T3「去掉空数组抛错」其实是 no-op；此锁固化真值，避免 P1 改错方向。
    expect(sealAnswersServerSide([makeQ('q1', 't')], [])).toEqual([])
  })

  test('sealAnswersServerSide 现状：非数组入参抛 clarify-answers-not-array（守卫不可随逐题改造丢失）', () => {
    expect(() =>
      // intentionally feed a non-array (runtime guard) without `any`
      sealAnswersServerSide([makeQ('q1', 't')], null as unknown as ClarifyAnswer[]),
    ).toThrow('answers payload must be an array')
  })

  test('整轮 seal：一轮提交恰好 mint 一条 cause=clarify-answer 续跑（node=提问节点, retry_index=0）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedSelfTask(db)
    const sourceRunId = 'nr_src_one_rerun'
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 2,
      iteration: 0,
      preSnapshot: '',
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQ('q1', 'Q1?')],
    })

    const { rerunNodeRunId } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAns('q1')],
    })

    // 整轮 seal 现状：恰好一条续跑，且 cause 是 scheduler gate-2 的 'clarify-answer'。
    // P5（self 逐题重跑）会把这条变成「每题一条」→ count>1，此锁先红。
    const clarifyAnswerReruns = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    ).filter((r) => r.rerunCause === 'clarify-answer')
    expect(clarifyAnswerReruns).toHaveLength(1)
    const rerun = clarifyAnswerReruns[0]!
    expect(rerun.id).toBe(rerunNodeRunId)
    expect(rerun.nodeId).toBe('designer') // 续跑落在提问节点身上
    expect(rerun.status).toBe('pending')
    expect(rerun.retryIndex).toBe(0) // clarify rerun 重置 retry 预算
  })

  test('整轮 seal：同一轮多题一次性全 seal 进 answers（无逐题 seal 态），且仍只一条续跑', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedSelfTask(db)
    const sourceRunId = 'nr_src_multiq'
    await db.insert(nodeRuns).values({
      id: sourceRunId,
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      preSnapshot: '',
    })
    const { clarifyNodeRunId } = await createClarifySession({
      db,
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: sourceRunId,
      sourceShardKey: null,
      clarifyNodeId: 'clarify1',
      iterationIndex: 0,
      questions: [makeQ('q1', 'first?'), makeQ('q2', 'second?')],
    })

    const { session } = await submitClarifyAnswers({
      db,
      clarifyNodeRunId,
      answers: [makeAns('q1'), makeAns('q2')],
    })

    // 现状：整轮一次 seal → 两题答案一起进 session.answers；轮 dual-write 一次翻 answered。
    expect(session.status).toBe('answered')
    expect(session.answers?.map((a) => a.questionId).sort()).toEqual(['q1', 'q2'])
    // 仍恰好一条续跑（不是每题一条）。
    const reruns = (await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))).filter(
      (r) => r.rerunCause === 'clarify-answer',
    )
    expect(reruns).toHaveLength(1)
    // 轮 dual-write 一次性翻 answered（P1 T4：仅全 seal 才翻，单题部分答时此处仍须 answered
    // 当且仅当全题 seal——本网钉死「全题一次提交 ⇒ answered」这条不变量）。
    const round = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId)))[0]
    expect(round?.status).toBe('answered')
    expect(JSON.parse(round?.answersJson ?? '[]')).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// #2 — cross questioner cascade：反问者整轮续跑 + designer 整轮承接
//
// 现有覆盖（cross-clarify-service.test.ts）：stop 路径 :353 锁了「mint questioner
// node_run + designer 不续跑」；continue/designer 路径 :624 锁 triggerDesignerRerun；
// buildExternalFeedbackContext :785 锁 designer 注入。它 *没有* 断言续跑的 cause 字段、
// 也没有断言「恰好一条」questioner 续跑。P5（questioner 逐题重跑）会把整轮一条变多条，
// 故在此补「cause='cross-clarify-questioner-rerun' + 恰好一条」锁。
// ---------------------------------------------------------------------------

function crossDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'design' },
        target: { nodeId: 'questioner', portName: 'design' },
      },
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_to_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
      {
        id: 'e_cross_to_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedCrossTask(db: DbClient): Promise<{
  taskId: string
  questionerRunId: string
}> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = crossDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p0-cross',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  const questionerRunId = `nr_q_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  await db.insert(nodeRuns).values({
    id: `nr_d_${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    preSnapshot: 'stub',
  })
  return { taskId, questionerRunId }
}

describe('RFC-128 P0 net — 整轮 seal 现状锁 #2: cross questioner cascade', () => {
  test('continue + all-questioner-scope：恰好一条 cause=cross-clarify-questioner-rerun 续跑，designer 不续跑', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, questionerRunId } = await seedCrossTask(db)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: questionerRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'spurious?')],
    })

    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
      questionScopes: { q1: 'questioner' }, // all-questioner-scope fast path
    })
    expect(ret.outcome.kind).toBe('questioner-continue-triggered')

    const all = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const qReruns = all.filter((r) => r.rerunCause === 'cross-clarify-questioner-rerun')
    expect(qReruns).toHaveLength(1) // 整轮一条（P5 逐题重跑会变多条）
    expect(qReruns[0]!.nodeId).toBe('questioner')
    // designer 不续跑（all-questioner-scope）。
    expect(all.filter((r) => r.nodeId === 'designer' && r.status === 'pending')).toHaveLength(0)
  })

  test('stop：恰好一条 cause=cross-clarify-questioner-rerun 续跑，designer 不续跑', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, questionerRunId } = await seedCrossTask(db)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: questionerRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'spurious?')],
    })

    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'stop',
    })
    expect(ret.outcome.kind).toBe('questioner-stop-triggered')

    const all = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const qReruns = all.filter((r) => r.rerunCause === 'cross-clarify-questioner-rerun')
    expect(qReruns).toHaveLength(1)
    expect(qReruns[0]!.nodeId).toBe('questioner')
    expect(all.filter((r) => r.nodeId === 'designer' && r.status === 'pending')).toHaveLength(0)
  })

  test('continue + designer-scoped：designer 整轮承接——一条 designer 续跑', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, questionerRunId } = await seedCrossTask(db)
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: questionerRunId,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1', 'Why Redis?')],
    })

    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue', // no scopes → all-designer default
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')

    // 恰好一条 designer 续跑（整轮一次承接）。
    const all = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    expect(all.filter((r) => r.nodeId === 'designer' && r.status === 'pending')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// #5 — RFC-070 整轮 aging：resolveTriggerForEntry 的「整轮 seal 门控」纯预言
//
// 现有覆盖（rfc070-aging-stamp-behavior.test.ts）锁了 markClarifyRoundsConsumedBy 的
// stamp 写入（B6/B7）、selectAnsweredRoundsForConsumer 的 IS NULL 过滤（B12），并由
// rfc070-aging-stamp-grep-guards.test.ts:83 锁「outputsPersistedCount > 0」即
// 「done+output 才 stamp」。但 resolveTriggerForEntry（services/taskQuestions.ts:169）
// 这个把「整轮是否 answered」翻译成「该 entry 是否已被处理」的纯预言 *没有* 任何直接
// 测试。它正是 P1（reconcile/phase 门控从整轮 roundAnswered 改逐题 questionSealed）会
// 触及的整轮决策点，故在此补锁：① 轮非 answered → 一律无 trigger（整轮 seal gate）；
// ② role→消费戳列映射（questioner=questioner 列，self/designer=consumer 列）；
// ③ answered 但 stamp 仍 NULL（done+output 未达）→ 无 trigger。
// ---------------------------------------------------------------------------

async function seedRoundRow(
  db: DbClient,
  over: {
    status: 'awaiting_human' | 'answered'
    consumedByConsumerRunId?: string | null
    consumedByQuestionerRunId?: string | null
  },
): Promise<typeof clarifyRounds.$inferSelect> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'stub',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: '{}',
    repoPath: '/tmp/r',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  // FK runs: asking + intermediary + (optional) handler consumer/questioner runs.
  const askId = `${taskId}-ask`
  const intId = `${taskId}-int`
  await db.insert(nodeRuns).values([
    { id: askId, taskId, nodeId: 'questioner', status: 'done' },
    { id: intId, taskId, nodeId: 'cross1', status: 'awaiting_human' },
  ])
  for (const h of [over.consumedByConsumerRunId, over.consumedByQuestionerRunId]) {
    if (h)
      await db
        .insert(nodeRuns)
        .values({ id: h, taskId, nodeId: 'designer', status: 'done' })
        .onConflictDoNothing()
  }
  const roundId = `r_${taskId}`
  await db.insert(clarifyRounds).values({
    id: roundId,
    taskId,
    kind: 'cross',
    askingNodeId: 'questioner',
    askingNodeRunId: askId,
    intermediaryNodeId: 'cross1',
    intermediaryNodeRunId: intId,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    iteration: 0,
    questionsJson: JSON.stringify([makeQ('q1', 't')]),
    answersJson: over.status === 'answered' ? JSON.stringify([makeAns('q1')]) : null,
    directive: 'continue',
    status: over.status,
    consumedByConsumerRunId: over.consumedByConsumerRunId ?? null,
    consumedByQuestionerRunId: over.consumedByQuestionerRunId ?? null,
  })
  return (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, roundId)))[0]!
}

describe('RFC-128 P0 net — 整轮 seal 现状锁 #5: RFC-070 resolveTriggerForEntry 整轮门控', () => {
  test('整轮 seal gate：round 非 answered（awaiting_human）→ 任何 role 都无 trigger（return null）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const round = await seedRoundRow(db, {
      status: 'awaiting_human',
      consumedByConsumerRunId: 'should-be-ignored-while-unanswered',
      consumedByQuestionerRunId: 'should-be-ignored-while-unanswered',
    })
    // 现状：整轮未 answered 时 entry 一律未 dispatched，连已写的消费戳都被忽略。
    // P1 把这条门控从「整轮 answered」改成「逐题 sealed」——届时本锁须迁移到逐题语义。
    expect(resolveTriggerForEntry(round, 'designer')).toBeNull()
    expect(resolveTriggerForEntry(round, 'questioner')).toBeNull()
    expect(resolveTriggerForEntry(round, 'self')).toBeNull()
  })

  test('role→消费戳列映射：designer/self 读 consumer 列，questioner 读 questioner 列', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const round = await seedRoundRow(db, {
      status: 'answered',
      consumedByConsumerRunId: 'nr_consumer',
      consumedByQuestionerRunId: 'nr_questioner',
    })
    expect(resolveTriggerForEntry(round, 'designer')).toBe('nr_consumer')
    expect(resolveTriggerForEntry(round, 'self')).toBe('nr_consumer')
    expect(resolveTriggerForEntry(round, 'questioner')).toBe('nr_questioner')
  })

  test('done+output 未达：answered 但消费戳仍 NULL → 无 trigger（戳指向 done+output 才算 consumed）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const round = await seedRoundRow(db, { status: 'answered' })
    expect(resolveTriggerForEntry(round, 'designer')).toBeNull()
    expect(resolveTriggerForEntry(round, 'questioner')).toBeNull()
  })
})
