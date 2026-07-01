// RFC-128 P3 — designer 域逐题下发 (AC-8)。先红后绿，service 级端到端。
//
// P3 放开 P1 的 P2-4a 临时「整轮 gate」：每 seal 一个 designer-scope 题即逐题出它的 designer
// 条目，可单独 stage → 走既有 dispatchTaskQuestions（§18）+ RFC-127 借壳下发，注入时只取该题
// 的 Q&A。三处必须同步 per-question（否则又成半可用 row）：
//
//   1. reconcile per-question (reconcileRoundEntriesTx) — 按该题 task_questions.sealed_at
//      != null（而非整轮 round.status）出 designer 条目（验证见 rfc128-p1 AC-2 + shared
//      task-questions-reconcile）。
//   2. dispatch readiness per-question (assertDesignerReady → evaluateDesignerRerunReadiness)
//      — 被下发的来源轮（partial、仍 awaiting_human）被豁免「pending」门，故该题 sealed 即可
//      dispatch，不必等兄弟题/兄弟源；UNRESOLVED 的兄弟源仍 gate（golden lock H3/H2，见
//      rfc120-deferred-dispatch）。
//   3. feedback injection per-question (buildNodeQueueExternalFeedback) — partial 轮也注入，
//      但只渲染被下发（已 sealed）题的 Q&A；未 seal 的兄弟题不进 answers_json、不注入。
//
// 锁的 AC-8 路径：
//   • partial Q1=designer seal → 出 Q1 designer 条目（Q2 未 seal 不出）→ stage（gate 放行）→
//     dispatch（partial 轮仍 awaiting_human）→ 注入仅 Q1 Q&A；
//   • 借壳：partial Q1 改派 OTHER → dispatch mint HOME=designer + agent_override_name=OTHER；
//   • 黄金锁：整轮一次 seal 全题 = 全题 designer 条目 + 注入全题 Q&A（= 旧整轮逐字）；
//   • CAS 防重（dispatched_at IS NULL）：重复 dispatch 同条目 → 不二次 mint。

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
} from '../src/services/crossClarify'
import { sealRoundQuestions } from '../src/services/clarifySeal'
import {
  listTaskQuestions,
  loadUndispatchedDesignerTargets,
  reassignTaskQuestion,
  stageTaskQuestion,
} from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node (no __external_feedback__ edge) — a valid reassign/borrow target whose
// agentName a clarify-designer override BORROWS (rides on the home designer's rerun).
const OTHER = 'other'
const OTHER_AGENT = 'other-agent'

const Q1_TITLE = 'QUESTION-ONE-distinctive-title'
const Q2_TITLE = 'QUESTION-TWO-distinctive-title'
const Q1_NOTE = 'CUSTOM-ANSWER-Q1-distinctive'

const actor = { userId: 'u1', role: 'owner' as const }

function liveDef(): WorkflowDefinition {
  const nodes: WorkflowNode[] = [
    { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: QUESTIONER, kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: OTHER, kind: 'agent-single', agentName: OTHER_AGENT } as WorkflowNode,
    { id: CC, kind: 'clarify-cross-agent', title: 'cc' } as WorkflowNode,
  ]
  return {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc',
        source: { nodeId: QUESTIONER, portName: '__clarify__' },
        target: { nodeId: CC, portName: 'questions' },
      },
      {
        id: 'e_cc_d',
        source: { nodeId: CC, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      },
      {
        id: 'e_cc_q',
        source: { nodeId: CC, portName: 'to_questioner' },
        target: { nodeId: QUESTIONER, portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
}

function mkQ(id: string, title: string): ClarifyQuestion {
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

/** A sealable answer (selectedOptionIndices → labels server-side); customText preserved so
 *  the injection block can be asserted distinctively. */
function ans(qid: string, note = ''): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: note }
}

/** Seed a DEFERRED cross task on liveDef + the designer's prior `done` draft + the questioner's
 *  `done` asking run (+ optionally OTHER's prior run), then open ONE cross-clarify session with
 *  [Q1, Q2]. Returns the task + the cross node-run id (= origin/intermediary). */
async function seedDeferredCrossTask(
  db: DbClient,
  opts: { otherHasRun?: boolean; questions?: ClarifyQuestion[] } = {},
): Promise<{ taskId: string; originNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  await db.insert(workflows).values({
    id: `wf_${taskId}`,
    name: 'rfc128-p3',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc128-p3',
    workflowId: `wf_${taskId}`,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc128-p3/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'awaiting_human',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: true,
  })
  await db.insert(nodeRuns).values({
    id: ulid(),
    taskId,
    nodeId: DESIGNER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  if (opts.otherHasRun) {
    await db.insert(nodeRuns).values({
      id: ulid(),
      taskId,
      nodeId: OTHER,
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      startedAt: Date.now() - 500,
    })
  }
  const questionerRunId = ulid()
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: QUESTIONER,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: CC,
    sourceQuestionerNodeId: QUESTIONER,
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: DESIGNER,
    loopIter: 0,
    questions: opts.questions ?? [mkQ('q1', Q1_TITLE), mkQ('q2', Q2_TITLE)],
  })
  return { taskId, originNodeRunId: crossClarifyNodeRunId }
}

function designerEntries(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
}

function roundStatus(db: DbClient, originNodeRunId: string) {
  return db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, originNodeRunId))
}

async function pendingDesignerRunCount(db: DbClient, taskId: string): Promise<number> {
  const rows = await db
    .select()
    .from(nodeRuns)
    .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
  return rows.filter((r) => r.status === 'pending').length
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// ---------------------------------------------------------------------------
// AC-8 主路径 — partial Q1=designer seal → 出 Q1 designer 条目 → stage → dispatch → 注入仅 Q1
// ---------------------------------------------------------------------------

describe('RFC-128 P3 — designer 逐题下发 (AC-8)', () => {
  test('partial Q1(designer) seal → Q1 designer 条目可 stage → dispatch（partial 轮仍 awaiting_human）→ 注入仅 Q1 Q&A', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)

    // (1) reconcile per-question: partial seal Q1 (designer scope) → Q1 designer 条目出现，Q2 不出。
    const sealRes = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    expect(sealRes.roundFullySealed).toBe(false)
    // 中介 cross node_run 仍 awaiting_human（partial 不关），任务由它把持、未提前完成。
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('awaiting_human')

    const before = await listTaskQuestions(db, taskId)
    const sig = before.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:questioner'])
    const q1Designer = before.find((d) => d.questionId === 'q1' && d.roleKind === 'designer')!
    expect(q1Designer.sealed).toBe(true)
    expect(q1Designer.phase).toBe('pending')
    // Q2 未 seal → 无 designer 条目。
    expect(before.some((d) => d.questionId === 'q2' && d.roleKind === 'designer')).toBe(false)

    // 待下发 gate (D5): Q1 已 seal → stage 放行。
    await stageTaskQuestion(db, q1Designer.id, true, actor)
    expect((await listTaskQuestions(db, taskId)).find((d) => d.id === q1Designer.id)?.phase).toBe(
      'staged',
    )

    // (2) dispatch readiness per-question: 该题 sealed 即可下发，partial 轮（其来源被豁免）不阻塞。
    const result = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const runId = result.reruns[0]!.nodeRunId
    // dispatch 不关 partial 轮（仍 awaiting_human——只 full seal 才关中介 node_run）。
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('awaiting_human')

    // (3) feedback injection per-question: per-node queue 在 partial 轮上注入，但只渲染 Q1 的 Q&A。
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx).toBeDefined()
    expect(ctx!.block).toContain(Q1_TITLE)
    expect(ctx!.block).toContain(Q1_NOTE) // Q1 的答案被注入
    expect(ctx!.block).not.toContain(Q2_TITLE) // 未 seal 的 Q2 绝不注入
    // 条目绑定到本次 rerun（处理中）。
    expect(
      (await designerEntries(db, taskId)).find((e) => e.id === q1Designer.id)?.triggerRunId,
    ).toBe(runId)
  })

  test('去借壳: partial Q1(designer) 改派 OTHER → dispatch mint TARGET=OTHER（own agent，无 agent_override）；注入仍仅 Q1', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db, { otherHasRun: true })

    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1Designer = (await designerEntries(db, taskId))[0]!
    expect(q1Designer.questionId).toBe('q1')
    expect(q1Designer.defaultTargetNodeId).toBe(DESIGNER)

    // RFC-131 T4 去借壳: 改派 → OTHER，run mint 在 effectiveTarget=OTHER（跑 OTHER 自己的 agent，无借壳）。
    await reassignTaskQuestion(db, q1Designer.id, OTHER, actor)
    const result = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(OTHER) // effective target, NOT the origin designer
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(OTHER)
    expect(minted?.rerunCause).toBe('cross-clarify-answer')
    expect(minted?.agentOverrideName).toBeNull() // 去借壳：OTHER 跑自己的 brain（无 agent_override）

    // 原 designer 节点自身不被 mint（条目已移到 OTHER）。
    const designerPending = (
      await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, DESIGNER)))
    ).filter((r) => r.status === 'pending')
    expect(designerPending.length).toBe(0)

    // TARGET OTHER 的 per-node queue（按 effectiveTarget=OTHER 选）注入仅 Q1。
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: OTHER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    expect(ctx!.block).toContain(Q1_TITLE)
    expect(ctx!.block).not.toContain(Q2_TITLE)
  })

  test('CAS 防重: 重复 dispatch 同一 Q1 designer 条目 → 不二次 mint（dispatched_at IS NULL 落空）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1Designer = (await designerEntries(db, taskId))[0]!

    const first = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(first.reruns.length).toBe(1)
    expect(await pendingDesignerRunCount(db, taskId)).toBe(1)

    // 二次 dispatch 同条目：已 dispatched_at → 选不中 → EMPTY_RESULT，不再 mint。
    const second = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(second.reruns.length).toBe(0)
    expect(second.dispatchedEntryIds.length).toBe(0)
    expect(await pendingDesignerRunCount(db, taskId)).toBe(1) // 仍只有第一条
  })

  // -------------------------------------------------------------------------
  // 黄金锁 — 整轮一次 seal 全题 = 全题 designer 条目 + dispatch + 注入全题 Q&A（= 旧整轮逐字）
  // -------------------------------------------------------------------------

  test('黄金锁: 整轮一次 seal 全题(designer) → 两题 designer 条目 → 一次 dispatch → 注入 Q1+Q2', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)

    // 一次性 seal 全题（= 旧整轮提交）：轮 answered。
    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE), ans('q2', 'CUSTOM-ANSWER-Q2')],
      scopes: { q1: 'designer', q2: 'designer' },
    })
    expect(res.roundFullySealed).toBe(true)
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('done') // full seal 关中介 node_run

    const list = await listTaskQuestions(db, taskId)
    const sig = list.map((d) => `${d.questionId}:${d.roleKind}`).sort()
    expect(sig).toEqual(['q1:designer', 'q1:questioner', 'q2:designer', 'q2:questioner'])

    const designers = (await designerEntries(db, taskId)).sort((a, b) =>
      a.questionId.localeCompare(b.questionId),
    )
    expect(designers.map((e) => e.questionId)).toEqual(['q1', 'q2'])

    // 整轮一次下发两题（同轮同 home=designer）→ 一条 rerun（= 旧整轮单 designer 续跑）。
    const result = await dispatchTaskQuestions(
      db,
      taskId,
      designers.map((e) => e.id),
      actor,
    )
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)

    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: result.reruns[0]!.nodeRunId,
    })
    // 全题注入：Q1 + Q2 都在 block 里（= 旧整轮逐字行为）。
    expect(ctx!.block).toContain(Q1_TITLE)
    expect(ctx!.block).toContain(Q2_TITLE)
    expect(ctx!.block).toContain(Q1_NOTE)
    expect(ctx!.block).toContain('CUSTOM-ANSWER-Q2')
  })

  test('Q2 未 seal 不可 stage（待下发 gate）：partial 只 seal Q1 时 Q2 designer 条目不存在 / questioner 条目未 seal', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const list = await listTaskQuestions(db, taskId)
    // Q2 没有 designer 条目；Q2 questioner 条目未 seal → stage 该 questioner 条目被 gate 拒。
    const q2Questioner = list.find((d) => d.questionId === 'q2' && d.roleKind === 'questioner')!
    expect(q2Questioner.sealed).toBe(false)
    let threw: unknown = null
    try {
      await stageTaskQuestion(db, q2Questioner.id, true, actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-not-sealed')
  })
})

// ---------------------------------------------------------------------------
// Codex impl-gate P2 修复 — reconcile per-question 边角：
//   P2-1 lazy 建 designer 行须带 sealed_at（同题已 sealed 时）→ 可 stage/注入；
//   P2-2 stop 收尾清理「desired 不含、existing 有」的未下发 designer 行（append-only 漏洞）。
// ---------------------------------------------------------------------------

describe('RFC-128 P3 — Codex P2 修复 (reconcile per-question 边角)', () => {
  test('P2-1: 同题先 sealed、designer 行后建（模拟 P2-4a 存量数据 rolling upgrade）→ lazy 建出的 designer 条目 sealed=true 且可 stage', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)

    // P3 partial seal Q1(designer) — 正常会建 Q1 designer 行（带 sealed_at）+ questioner 行。
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    // 模拟 P2-4a 存量：当年 partial seal 不建 designer 行 → 删掉它，只留已 sealed 的 questioner 行。
    // （rolling upgrade 到 P3 后，lazy reconcile 才第一次为这个已 sealed 的题创建 designer 行。）
    await db
      .delete(taskQuestions)
      .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
    const q1QuestionerRow = (
      await db
        .select()
        .from(taskQuestions)
        .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.questionId, 'q1')))
    )[0]
    expect(q1QuestionerRow?.roleKind).toBe('questioner')
    expect(q1QuestionerRow?.sealedAt).not.toBeNull() // 该题已 sealed（questioner 行带戳）

    // lazy reconcile 重建 Q1 designer 行 —— 必须继承该题的 sealed_at（P2-1 修复）。修复前：新行
    // sealed_at=NULL → 在 partial 轮（awaiting_human）下 DTO sealed=false、无法 stage（即便答案已锁）。
    const list = await listTaskQuestions(db, taskId)
    const q1Designer = list.find((d) => d.questionId === 'q1' && d.roleKind === 'designer')!
    expect(q1Designer).toBeDefined()
    expect(q1Designer.sealed).toBe(true)
    expect(q1Designer.phase).toBe('pending')
    // 行自身 sealed_at 落库（stage gate / 注入都靠它）。
    const designerRow = (
      await db.select().from(taskQuestions).where(eq(taskQuestions.id, q1Designer.id))
    )[0]
    expect(designerRow?.sealedAt).not.toBeNull()

    // 可 stage（待下发 gate 用行自身 sealed_at）。
    await stageTaskQuestion(db, q1Designer.id, true, actor)
    expect((await listTaskQuestions(db, taskId)).find((d) => d.id === q1Designer.id)?.phase).toBe(
      'staged',
    )
  })

  test('P2-2: partial continue 建 Q1 designer 后以 stop 收尾 → Q1 designer 条目被清、列表无 designer、不可下发；questioner 条目不动', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)

    // partial seal Q1(continue 默认, designer scope) → P3 立即建 Q1 designer 条目（未下发）。
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1DesignerBefore = (await designerEntries(db, taskId)).find((e) => e.questionId === 'q1')!
    expect(q1DesignerBefore).toBeDefined()
    expect(q1DesignerBefore.dispatchedAt).toBeNull()

    // 以 directive='stop' 收尾该轮（seal 剩余 Q2 → 全 seal + stop）。stop 轮不应产 designer rerun。
    const res2 = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q2')],
      scopes: { q2: 'designer' },
      directive: 'stop',
    })
    expect(res2.roundFullySealed).toBe(true)

    // 清理：append-only 漏洞被堵 → 列表无任何 designer 条目（含此前 partial 建的 Q1）。
    const list = await listTaskQuestions(db, taskId)
    expect(list.some((d) => d.roleKind === 'designer')).toBe(false)
    // questioner/self 条目绝不被清（约束②）。
    expect(
      list
        .filter((d) => d.roleKind === 'questioner')
        .map((d) => d.questionId)
        .sort(),
    ).toEqual(['q1', 'q2'])

    // 此前的 Q1 designer 条目已删 → 不可下发（防 stop 后残留行 mint designer rerun）。
    const result = await dispatchTaskQuestions(db, taskId, [q1DesignerBefore.id], actor)
    expect(result.reruns.length).toBe(0)
    expect(result.dispatchedEntryIds.length).toBe(0)
    // §18 park 也不把持（stop 轮 directive!=continue + 无 designer 条目）。
    const parked = await loadUndispatchedDesignerTargets(db, taskId)
    expect(parked.has(DESIGNER)).toBe(false)
  })

  test('P2-2 幂等: continue partial 轮多次 lazy reconcile 不误删 Q1 designer 条目（continue desired 含它）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    // 多次 lazy reconcile（每次都跑 cleanup）→ Q1 designer 条目恒在（continue 轮 desired 含它）。
    for (let i = 0; i < 3; i++) {
      const list = await listTaskQuestions(db, taskId)
      expect(list.some((d) => d.questionId === 'q1' && d.roleKind === 'designer')).toBe(true)
    }
    // 未被误删 → 仍可下发。
    const q1Designer = (await designerEntries(db, taskId)).find((e) => e.questionId === 'q1')!
    const result = await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(result.reruns.length).toBe(1)
  })

  test('P2-2 不误伤已下发: stop 收尾不清理 ALREADY-dispatched designer 条目（约束①——既成事实）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db)
    // partial seal Q1(continue, designer) → dispatch（mint rerun）→ Q1 designer 条目已 dispatched。
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1Designer = (await designerEntries(db, taskId)).find((e) => e.questionId === 'q1')!
    await dispatchTaskQuestions(db, taskId, [q1Designer.id], actor)
    expect(
      (await designerEntries(db, taskId)).find((e) => e.id === q1Designer.id)?.dispatchedAt,
    ).not.toBeNull()

    // 后续以 stop 收尾（seal Q2 stop）→ 清理只动 UNDISPATCHED designer 行，已下发的 Q1 保留。
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q2')],
      scopes: { q2: 'designer' },
      directive: 'stop',
    })
    const q1After = (await designerEntries(db, taskId)).find((e) => e.id === q1Designer.id)
    expect(q1After).toBeDefined() // 已下发 → 不被 stop cleanup 回收（约束①）
    expect(q1After?.dispatchedAt).not.toBeNull()
  })

  test('P2 re-gate: PARTIAL stop seal（q3 仍 open）不清理 designer 行 → q1 designer 仍在且保住 staged+override（directive 未 finalize）', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // 3 题 round：partial stop（seal q2）后 q3 仍 open → 轮仍 awaiting_human、directive 未 persist。
    const { taskId, originNodeRunId } = await seedDeferredCrossTask(db, {
      questions: [mkQ('q1', Q1_TITLE), mkQ('q2', Q2_TITLE), mkQ('q3', 'Q3-distinctive-title')],
    })

    // partial seal q1(continue 默认, designer) → q1 designer 行；stage + 改派 OTHER（人工覆盖层）。
    await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q1', Q1_NOTE)],
      scopes: { q1: 'designer' },
    })
    const q1Designer = (await designerEntries(db, taskId)).find((e) => e.questionId === 'q1')!
    await stageTaskQuestion(db, q1Designer.id, true, actor)
    await reassignTaskQuestion(db, q1Designer.id, OTHER, actor) // override 覆盖层

    // partial seal q2 携 directive='stop'（q3 仍 open）→ 轮不翻、directive NOT persist。
    const res = await sealRoundQuestions({
      db,
      originNodeRunId,
      answers: [ans('q2')],
      scopes: { q2: 'designer' },
      directive: 'stop',
    })
    expect(res.roundFullySealed).toBe(false)
    expect((await roundStatus(db, originNodeRunId))[0]?.status).toBe('awaiting_human')

    // 核心断言：q1 designer 行未被误删，且 staged + override 覆盖层完整（修复前会被 cleanup 删→
    // lazy 重建成 unstaged/无 override，丢覆盖层）。
    const list = await listTaskQuestions(db, taskId)
    const q1AfterDto = list.find((d) => d.questionId === 'q1' && d.roleKind === 'designer')
    expect(q1AfterDto).toBeDefined()
    expect(q1AfterDto?.phase).toBe('staged') // 覆盖层 staged 保留
    expect(q1AfterDto?.overrideTargetNodeId).toBe(OTHER) // 覆盖层 override 保留
    // 行 id 不变（是保留、不是删-重建）。
    expect(q1AfterDto?.id).toBe(q1Designer.id)
  })
})
