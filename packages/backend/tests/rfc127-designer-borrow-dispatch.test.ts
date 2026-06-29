// RFC-127 T5 — designer dispatch 从「换节点」切「借壳」(borrow-the-shell). Positive lock for the
// core dimension flip:
//
//   home  = default ?? override   (the node a rerun is MINTED on — run.node_id)
//   borrow = override             (only when override ≠ home; the node whose AGENT is borrowed)
//
//   • clarify-designer, no override → home=default=D, borrow=null
//       → mint node_id=D, agent_override_name NULL (byte-for-byte the baseline).
//   • clarify-designer, override X  → home=default=D, borrow=X
//       → mint node_id=**D** (NOT X!) + agent_override_name = X 节点的 agentName;
//         产出归 D、走 D 下游 (借壳：D runs X's brain on D's artifact).
//   • manual (default=null)         → home=override=X, borrow=null
//       → mint node_id=X, no override (byte-for-byte the baseline; covered in rfc120 manual tests).
//
// These tests lock the override (clarify) borrow path end-to-end: the per-home single-borrow gate,
// the golden-lock no-override baseline, and the never-run borrow relaxation. The reversed/adapted
// old-behavior cases live in rfc120-deferred-dispatch.test.ts; this file is the dedicated
// positive net so a refactor that re-introduces "override moves the home" goes red here.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { reassignTaskQuestion } from '../src/services/taskQuestions'
import { dispatchTaskQuestions } from '../src/services/taskQuestionDispatch'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const DESIGNER = 'designer'
const QUESTIONER = 'questioner'
const CC = 'cross1'
// A plain agent node (no __external_feedback__ edge) — a valid reassign/borrow target. Its
// agentName is what a clarify-designer override BORROWS (rides on the home designer's rerun).
const OTHER = 'other'
const OTHER_AGENT = 'other'

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

function ans(qid: string) {
  return {
    questionId: qid,
    selectedOptionIndices: [0],
    selectedOptionLabels: ['A'],
    customText: '',
  }
}

/** Seed a DEFERRED task on liveDef + the designer's prior `done` draft + the questioner's
 *  `done` asking run, then open one cross-clarify session. Optionally seed OTHER's prior run. */
async function seedTask(
  db: DbClient,
  opts: { otherHasRun: boolean },
): Promise<{ taskId: string; crossClarifyNodeRunId: string }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = liveDef()
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc127-borrow',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc127-borrow',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc127/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
    deferredQuestionDispatch: true,
  })
  // ULID ids (production-accurate freshness ordering): the seeded runs sort BEFORE later mints.
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
    questions: [mkQ('q1', 'designer-scoped?')],
  })
  return { taskId, crossClarifyNodeRunId }
}

async function designerEntries(db: DbClient, taskId: string) {
  return db
    .select()
    .from(taskQuestions)
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.roleKind, 'designer')))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-127 T5 — designer dispatch 借壳 (borrow the shell)', () => {
  test('借壳 mint: clarify-designer override X → mint the HOME D + agent_override_name = X’s agentName (NOT a mint on X)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: true })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.defaultTargetNodeId).toBe(DESIGNER)
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // override → OTHER (borrow its agent)

    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    // home = default ?? override = DESIGNER → the rerun is minted ON DESIGNER.
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const runId = result.reruns[0]!.nodeRunId

    const minted = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, runId)))[0]
    expect(minted?.nodeId).toBe(DESIGNER) // node_id is the HOME, not the borrowed node
    expect(minted?.status).toBe('pending')
    expect(minted?.rerunCause).toBe('cross-clarify-answer')
    expect(minted?.agentOverrideName).toBe(OTHER_AGENT) // borrow = X node's agentName

    // The borrowed node X is NEVER minted — no run appears on OTHER beyond the seeded done one.
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.some((r) => r.status === 'pending')).toBe(false)

    // The HOME D's per-node queue (keyed by home=default) carries + binds the answer to D's rerun.
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: DESIGNER,
      loopIter: 0,
      designerGeneration: 1,
      definition: liveDef(),
      dispatchedRunId: runId,
    })
    expect(ctx?.block).toContain('A')
    expect(ctx?.graphOwned).toBe(true) // default==home==DESIGNER → D owns its artifact (D3)
    expect((await designerEntries(db, taskId))[0]?.triggerRunId).toBe(runId)
  })

  test('per-home 多借用门: two rounds default=D but override→X1/X2 → one dispatch is rejected task-question-home-multi-borrow (nothing stamped/minted)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    // Two cross-clarify sources both → DESIGNER (one home), plus two distinct borrow targets X1/X2.
    const X1 = 'fix1'
    const X2 = 'fix2'
    const nodes: WorkflowNode[] = [
      { id: DESIGNER, kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: X1, kind: 'agent-single', agentName: 'fix1' } as WorkflowNode,
      { id: X2, kind: 'agent-single', agentName: 'fix2' } as WorkflowNode,
      { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
      { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
      { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
      { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
    ]
    const edges: WorkflowDefinition['edges'] = []
    for (const { q, cc } of [
      { q: 'q_a', cc: 'cc_a' },
      { q: 'q_b', cc: 'cc_b' },
    ]) {
      edges.push({
        id: `e_q_${cc}`,
        source: { nodeId: q, portName: '__clarify__' },
        target: { nodeId: cc, portName: 'questions' },
      })
      edges.push({
        id: `e_d_${cc}`,
        source: { nodeId: cc, portName: 'to_designer' },
        target: { nodeId: DESIGNER, portName: '__external_feedback__' },
      })
      edges.push({
        id: `e_qb_${cc}`,
        source: { nodeId: cc, portName: 'to_questioner' },
        target: { nodeId: q, portName: '__clarify_response__' },
      })
    }
    const def: WorkflowDefinition = { $schema_version: 4, inputs: [], nodes, edges, outputs: [] }
    const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
    await db.insert(workflows).values({
      id: `wf_${taskId}`,
      name: 'rfc127-multi-borrow',
      description: '',
      definition: JSON.stringify(def),
      version: 1,
      schemaVersion: 4,
    })
    await db.insert(tasks).values({
      id: taskId,
      name: 'rfc127-multi-borrow',
      workflowId: `wf_${taskId}`,
      workflowSnapshot: JSON.stringify(def),
      repoPath: '/tmp/aw-rfc127-mb/repo',
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${taskId}`,
      status: 'running',
      inputs: JSON.stringify({}),
      startedAt: Date.now(),
      deferredQuestionDispatch: true,
    })
    await db
      .insert(nodeRuns)
      .values({ id: ulid(), taskId, nodeId: DESIGNER, status: 'done', retryIndex: 0, iteration: 0 })
    const open = async (q: string, cc: string, qid: string): Promise<string> => {
      const runId = ulid()
      await db
        .insert(nodeRuns)
        .values({ id: runId, taskId, nodeId: q, status: 'done', retryIndex: 0, iteration: 0 })
      const { crossClarifyNodeRunId } = await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: cc,
        sourceQuestionerNodeId: q,
        sourceQuestionerNodeRunId: runId,
        targetDesignerNodeId: DESIGNER,
        loopIter: 0,
        questions: [mkQ(qid, 'designer-scoped?')],
      })
      return crossClarifyNodeRunId
    }
    const ccA = await open('q_a', 'cc_a', 'a1')
    const ccB = await open('q_b', 'cc_b', 'b1')
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccA,
      answers: [ans('a1')],
      directive: 'continue',
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: ccB,
      answers: [ans('b1')],
      directive: 'continue',
    })
    const entryA = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccA)!
    const entryB = (await designerEntries(db, taskId)).find((e) => e.originNodeRunId === ccB)!
    // Both default=DESIGNER → both home=DESIGNER; but they borrow DIFFERENT agents (X1 vs X2).
    await reassignTaskQuestion(db, entryA.id, X1, actor)
    await reassignTaskQuestion(db, entryB.id, X2, actor)

    // One dispatch onto the SAME home that names two borrow agents → a single rerun can run only
    // ONE agent → reject the whole dispatch up front (no partial stamp/mint).
    let threw: unknown = null
    try {
      await dispatchTaskQuestions(db, taskId, [entryA.id, entryB.id], actor)
    } catch (e) {
      threw = e
    }
    expect((threw as { code?: string }).code).toBe('task-question-home-multi-borrow')
    // Nothing stamped, nothing minted.
    expect((await designerEntries(db, taskId)).every((e) => e.dispatchedAt === null)).toBe(true)
    const pending = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.status, 'pending')))
    expect(pending.length).toBe(0)
  })

  test('golden-lock: a clarify-designer with NO override → mint D + agent_override_name NULL (byte-for-byte the baseline)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: false })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    expect(entry.overrideTargetNodeId).toBeNull() // no override → home=default=DESIGNER, borrow=null

    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(DESIGNER)
    expect(minted?.agentOverrideName).toBeNull() // NO borrow → home runs its own agent
  })

  test('never-run 借用放宽: override to a NEVER-RUN node X, but home D has a run → dispatch succeeds (mint D borrowing X)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, crossClarifyNodeRunId } = await seedTask(db, { otherHasRun: false }) // OTHER never ran
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [ans('q1')],
      directive: 'continue',
    })
    const entry = (await designerEntries(db, taskId))[0]!
    await reassignTaskQuestion(db, entry.id, OTHER, actor) // borrow a never-run node's agent

    // home D HAS a run (the frontier mint inherits it); X is only the borrowed agent (never minted),
    // so its never-run state is irrelevant — dispatch SUCCEEDS (no unsafe-dispatch-target).
    const result = await dispatchTaskQuestions(db, taskId, [entry.id], actor)
    expect(result.reruns.length).toBe(1)
    expect(result.reruns[0]?.targetNodeId).toBe(DESIGNER)
    const minted = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, result.reruns[0]!.nodeRunId))
    )[0]
    expect(minted?.nodeId).toBe(DESIGNER)
    expect(minted?.agentOverrideName).toBe(OTHER_AGENT)
    // The never-run borrowed node still has NO node_run.
    const otherRuns = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, OTHER)))
    expect(otherRuns.length).toBe(0)
  })
})
