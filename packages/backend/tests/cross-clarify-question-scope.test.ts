// RFC-059 — per-question scope service tests (RFC-132: driven via the unified
// quick channel, autoDispatchClarifyRound — scopes flow through seal → reconcile
// → dispatch).
//
// Why these tests exist:
//   Locks the per-question scope semantics of answering a cross round:
//     1. backward compat (no questionScopes) → designer-scope default, designer
//        rerun dispatched
//     2. explicit all-designer scopes → designer rerun + JSON persisted
//     3. all-questioner scopes → questioner continuation only, NO designer
//        entry / rerun
//     4. mixed scopes → designer rerun dispatched + scope persisted (A3b)
//     5. multi-source single all-questioner peer → that peer's questioner
//        continuation mints while the other peer is still awaiting (designer
//        untouched)
//     6. multi-source aggregated designer-count = 0 → no designer rerun at all
//     7. reject + mixed scope → directive='stop' wins, scope ignored at
//        runtime but persisted for audit
//     8. malformed questionScopes (unknown questionId / non-enum value)
//        → ValidationError with code 'cross-clarify-question-scopes-malformed'
//     9. dual-write parity: cross_clarify_sessions.questionScopesJson and
//        clarify_rounds.questionScopesJson stay byte-equivalent across the
//        answer (regression guard against single-table write drift).
//
// These cases collectively also guard:
//   - RFC-058 dual-write (any read site failing to mirror would fail #9)
//   - proposal A2, A3, A4, A5, A6, A7, A9 acceptance.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  crossClarifySessions,
  nodeRuns,
  taskQuestions,
  tasks,
  workflows,
} from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  ClarifyQuestionScope,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

/** The dual-written pair for an answered round, fetched by the shared row id
 *  (clarify_rounds.id === cross_clarify_sessions.id) via the origin node_run. */
async function fetchPairByOrigin(db: DbClient, ccRunId: string) {
  const unified = (
    await db.select().from(clarifyRounds).where(eq(clarifyRounds.intermediaryNodeRunId, ccRunId))
  )[0]
  const legacy = (
    await db
      .select()
      .from(crossClarifySessions)
      .where(eq(crossClarifySessions.crossClarifyNodeRunId, ccRunId))
  )[0]
  return { unified, legacy }
}

async function seedTask(
  db: DbClient,
  opts: {
    id?: string
    questionerNodeIds?: string[]
    crossClarifyNodeIds?: string[]
  } = {},
): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = opts.id ?? `task_${Math.random().toString(36).slice(2, 8)}`
  const designerNodeId = 'designer'
  const questionerNodeIds = opts.questionerNodeIds ?? ['questioner']
  const crossClarifyNodeIds = opts.crossClarifyNodeIds ?? ['cc1']
  const nodes: WorkflowNode[] = [
    { id: designerNodeId, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    ...questionerNodeIds.map(
      (qid) =>
        ({
          id: qid,
          kind: 'agent-single',
          agentName: qid,
        }) as WorkflowNode,
    ),
    ...crossClarifyNodeIds.map(
      (ccId) =>
        ({
          id: ccId,
          kind: 'clarify-cross-agent',
          title: ccId,
        }) as WorkflowNode,
    ),
  ]
  const edges = [] as WorkflowDefinition['edges']
  for (let i = 0; i < crossClarifyNodeIds.length; i++) {
    const ccId = crossClarifyNodeIds[i]!
    const qId = questionerNodeIds[Math.min(i, questionerNodeIds.length - 1)]!
    edges.push({
      id: `e_q_${ccId}`,
      source: { nodeId: qId, portName: '__clarify__' },
      target: { nodeId: ccId, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${ccId}`,
      source: { nodeId: ccId, portName: 'to_designer' },
      target: { nodeId: designerNodeId, portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${ccId}`,
      source: { nodeId: ccId, portName: 'to_questioner' },
      target: { nodeId: qId, portName: '__clarify_response__' },
    })
  }
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc-059-stub',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    name: 'rfc-059-fixture',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition: def }
}

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

function makeA(id: string): ClarifyAnswer {
  return {
    questionId: id,
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
  }
}

async function seedDesigner(db: DbClient, taskId: string): Promise<void> {
  await db.insert(nodeRuns).values({
    id: 'nr_d_1',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
}

async function spawnSession(
  db: DbClient,
  args: {
    taskId: string
    questionerRunId: string
    questionerNodeId?: string
    ccNodeId?: string
    questions: ClarifyQuestion[]
  },
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: args.questionerRunId,
    taskId: args.taskId,
    nodeId: args.questionerNodeId ?? 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId: args.taskId,
    crossClarifyNodeId: args.ccNodeId ?? 'cc1',
    sourceQuestionerNodeId: args.questionerNodeId ?? 'questioner',
    sourceQuestionerNodeRunId: args.questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: args.questions,
  })
  return crossClarifyNodeRunId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 — answering a cross round / questionScopes (unified quick channel)', () => {
  test('1. no questionScopes → designer rerun + both tables NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const result = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      actor,
    })
    // Default scope is designer → the designer rerun is dispatched.
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
    const { unified, legacy } = await fetchPairByOrigin(db, ccRunId)
    expect(legacy?.questionScopesJson).toBeNull()
    expect(unified?.questionScopesJson).toBeNull()
    expect(definition).toBeDefined()
  })

  test('2. all-designer scopes → designer rerun + persisted JSON on both tables', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = { q1: 'designer', q2: 'designer' }
    const result = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      scopes,
      actor,
    })
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
    const { unified, legacy } = await fetchPairByOrigin(db, ccRunId)
    expect(legacy?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(unified?.questionScopesJson).toBe(JSON.stringify(scopes))
  })

  test('3. all-questioner scopes → questioner continuation only, designer not rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = { q1: 'questioner', q2: 'questioner' }
    const result = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      scopes,
      actor,
    })
    // Only the questioner continuation mints; questioner-scope questions produce NO
    // designer entries at all.
    const questionerRerun = result.dispatch.reruns.find((r) => r.targetNodeId === 'questioner')
    expect(questionerRerun?.nodeRunId).toBeTruthy()
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const entries = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, ccRunId))
    expect(entries.some((e) => e.roleKind === 'designer')).toBe(false)
    // Designer must NOT have been rerun — only the original designer row exists.
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('4. mixed scopes → designer rerun dispatched + scope persisted (A3b)', async () => {
    // RFC-059 A3b: a mixed-scope answer dispatches the designer rerun and
    // persists the per-question scopes. (The questioner-cascade "reads FULL
    // Q&A regardless of scope" assertion rode the removed cross-questioner
    // injector; the flat queue renderer's coverage lives in rfc132 tests.)
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const result = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      scopes: { q1: 'designer', q2: 'questioner' },
      actor,
    })
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
    // Scope persistence sanity (already covered by #9 but doubled here so
    // a regression that strips scope from #9's specific shape would still
    // show up alongside the A3b check).
    const { legacy } = await fetchPairByOrigin(db, ccRunId)
    expect(legacy?.questionScopesJson).toBe(JSON.stringify({ q1: 'designer', q2: 'questioner' }))
  })

  test('5. multi-source — peer A all-questioner continuation; peer B awaiting → designer untouched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, {
      crossClarifyNodeIds: ['cc_a', 'cc_b'],
      questionerNodeIds: ['q_a', 'q_b'],
    })
    await seedDesigner(db, taskId)
    const aRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_a',
      questionerNodeId: 'q_a',
      ccNodeId: 'cc_a',
      questions: [makeQ('a1', 'a-first')],
    })
    await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_b',
      questionerNodeId: 'q_b',
      ccNodeId: 'cc_b',
      questions: [makeQ('b1', 'b-first')],
    })
    // Peer A answers all-questioner — its continuation mints even though peer B is
    // still awaiting (the questioner continuation has no multi-source readiness gate).
    const aResult = await autoDispatchClarifyRound({
      db,
      originNodeRunId: aRunId,
      answers: [makeA('a1')],
      scopes: { a1: 'questioner' },
      actor,
    })
    expect(aResult.dispatch.reruns.some((r) => r.targetNodeId === 'q_a')).toBe(true)
    expect(aResult.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    // Designer still has only its initial run — peer B hasn't decided yet.
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('6. multi-source aggregated designer-count = 0 → no designer rerun at all', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db, {
      crossClarifyNodeIds: ['cc_a', 'cc_b'],
      questionerNodeIds: ['q_a', 'q_b'],
    })
    await seedDesigner(db, taskId)
    const aRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_a',
      questionerNodeId: 'q_a',
      ccNodeId: 'cc_a',
      questions: [makeQ('a1', 'a-first')],
    })
    const bRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_b',
      questionerNodeId: 'q_b',
      ccNodeId: 'cc_b',
      questions: [makeQ('b1', 'b-first')],
    })
    // Peer A answers all-questioner — questioner continuation only.
    await autoDispatchClarifyRound({
      db,
      originNodeRunId: aRunId,
      answers: [makeA('a1')],
      scopes: { a1: 'questioner' },
      actor,
    })
    // Peer B also answers all-questioner. With every question questioner-scoped,
    // NO designer entry exists anywhere → nothing to dispatch to the designer even
    // though all siblings are now resolved (the legacy 'designer-skipped-all-
    // questioner-scope' outcome).
    const bResult = await autoDispatchClarifyRound({
      db,
      originNodeRunId: bRunId,
      answers: [makeA('b1')],
      scopes: { b1: 'questioner' },
      actor,
    })
    expect(bResult.dispatch.reruns.some((r) => r.targetNodeId === 'q_b')).toBe(true)
    expect(bResult.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(1)
  })

  test('7. reject + mixed scope → questioner stop rerun; questionScopesJson persisted but ignored', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = { q1: 'designer', q2: 'questioner' }
    const result = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2')],
      directive: 'stop',
      scopes,
      actor,
    })
    // stop → the questioner stop rerun mints; NO designer entries / rerun (scope
    // ignored at runtime — a stop round suppresses the designer continuation).
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'questioner')).toBe(true)
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    // Persisted for audit even though runtime ignores it on reject path.
    const { legacy } = await fetchPairByOrigin(db, ccRunId)
    expect(legacy?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(legacy?.directive).toBe('stop')
  })

  test('8. malformed questionScopes (unknown questionId) → cross-clarify-question-scopes-malformed 400', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first')],
    })
    await expect(
      autoDispatchClarifyRound({
        db,
        originNodeRunId: ccRunId,
        answers: [makeA('q1')],
        scopes: { unknown_id: 'designer' },
        actor,
      }),
    ).rejects.toMatchObject({
      code: 'cross-clarify-question-scopes-malformed',
    })
  })

  test('8b. malformed questionScopes (non-enum value) → cross-clarify-question-scopes-malformed 400', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first')],
    })
    await expect(
      autoDispatchClarifyRound({
        db,
        originNodeRunId: ccRunId,
        answers: [makeA('q1')],
        scopes: { q1: 'both' as unknown as ClarifyQuestionScope },
        actor,
      }),
    ).rejects.toMatchObject({
      code: 'cross-clarify-question-scopes-malformed',
    })
  })

  test('9. dual-write parity — both tables receive identical questionScopesJson', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await seedDesigner(db, taskId)
    const ccRunId = await spawnSession(db, {
      taskId,
      questionerRunId: 'nr_q_1',
      questions: [makeQ('q1', 'first'), makeQ('q2', 'second'), makeQ('q3', 'third')],
    })
    const scopes: Record<string, ClarifyQuestionScope> = {
      q1: 'designer',
      q2: 'questioner',
      q3: 'designer',
    }
    const result = await autoDispatchClarifyRound({
      db,
      originNodeRunId: ccRunId,
      answers: [makeA('q1'), makeA('q2'), makeA('q3')],
      scopes,
      actor,
    })
    expect(result.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(true)
    const { unified, legacy } = await fetchPairByOrigin(db, ccRunId)
    expect(legacy?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(unified?.questionScopesJson).toBe(JSON.stringify(scopes))
    expect(legacy?.questionScopesJson).toBe(unified?.questionScopesJson)
  })
})
