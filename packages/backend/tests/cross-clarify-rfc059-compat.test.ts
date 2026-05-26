// RFC-059 C1 — byte-level compatibility lock: when the client does NOT send
// questionScopes (RFC-056 / RFC-058 legacy behaviour), the post-RFC-059
// runtime must produce designer External Feedback + questioner cascade
// rerun output that is byte-identical to what the equivalent
// scopes=all-designer payload yields. This guards the "NULL fallback"
// path in `resolveQuestionScope` against silent drift.
//
// We can't snapshot against the literal pre-RFC-059 main HEAD here (we'd
// need to keep a baseline checkout around), but the property "NULL scopes
// produce the same output as all-designer scopes" is a tight equivalent.
// If a regression sneaks in (e.g. someone forgets the NULL fallback in
// the designer External Feedback builder), this test goes red and the
// commit message will spell out the diverging condition.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { buildPromptContext } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyQuestion,
  ClarifyQuestionScope,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient, taskId: string): Promise<WorkflowDefinition> {
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: 'cc1', kind: 'clarify-cross-agent', title: 'cc1' } as WorkflowNode,
  ]
  const edges = [
    {
      id: 'e_q',
      source: { nodeId: 'questioner', portName: '__clarify__' },
      target: { nodeId: 'cc1', portName: 'questions' },
    },
    {
      id: 'e_d',
      source: { nodeId: 'cc1', portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    },
    {
      id: 'e_qb',
      source: { nodeId: 'cc1', portName: 'to_questioner' },
      target: { nodeId: 'questioner', portName: '__clarify_response__' },
    },
  ]
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
    name: 'rfc-059-compat',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc-059-compat',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059-compat/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  await db.insert(nodeRuns).values({
    id: 'nr_d_1',
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now() - 1000,
  })
  return def
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

async function runSubmit(
  db: DbClient,
  taskId: string,
  scopes: Record<string, ClarifyQuestionScope> | undefined,
  questionerRunId: string,
): Promise<void> {
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: 'cc1',
    sourceQuestionerNodeId: 'questioner',
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
  })
  const result = await submitCrossClarifyAnswers({
    db,
    crossClarifyNodeRunId,
    answers: [
      { questionId: 'q1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      { questionId: 'q2', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
    ],
    directive: 'continue',
    ...(scopes !== undefined ? { questionScopes: scopes } : {}),
  })
  // Clear designer_run_triggered_at on both tables so the External Feedback
  // builder can be re-queried (it filters out consumed sources).
  await db
    .update(crossClarifySessions)
    .set({ designerRunTriggeredAt: null })
    .where(eq(crossClarifySessions.id, result.session.id))
  await db
    .update(clarifyRounds)
    .set({ designerRunTriggeredAt: null })
    .where(eq(clarifyRounds.id, result.session.id))
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 C1 — NULL-scopes path is byte-equivalent to all-designer-scopes path', () => {
  test('designer External Feedback block — no questionScopes vs explicit all-designer', async () => {
    const dbA = createInMemoryDb(MIGRATIONS)
    const dbB = createInMemoryDb(MIGRATIONS)
    const defA = await seedTask(dbA, 'task_A')
    const defB = await seedTask(dbB, 'task_B')
    await runSubmit(dbA, 'task_A', undefined, 'nr_q_a')
    await runSubmit(dbB, 'task_B', { q1: 'designer', q2: 'designer' }, 'nr_q_b')

    const ctxA = await buildExternalFeedbackContext({
      db: dbA,
      taskId: 'task_A',
      designerNodeId: 'designer',
      loopIter: 0,
      designerClarifyIteration: 1,
      definition: defA,
    })
    const ctxB = await buildExternalFeedbackContext({
      db: dbB,
      taskId: 'task_B',
      designerNodeId: 'designer',
      loopIter: 0,
      designerClarifyIteration: 1,
      definition: defB,
    })
    expect(ctxA).toBeDefined()
    expect(ctxB).toBeDefined()
    expect(ctxA!.block).toBe(ctxB!.block)
    expect(ctxA!.iteration).toBe(ctxB!.iteration)
    expect(ctxA!.sourcesCsv).toBe(ctxB!.sourcesCsv)
  })

  test('questioner cascade rerun prompt — no questionScopes vs explicit all-designer', async () => {
    const dbA = createInMemoryDb(MIGRATIONS)
    const dbB = createInMemoryDb(MIGRATIONS)
    const defA = await seedTask(dbA, 'task_A')
    const defB = await seedTask(dbB, 'task_B')
    await runSubmit(dbA, 'task_A', undefined, 'nr_q_a')
    await runSubmit(dbB, 'task_B', { q1: 'designer', q2: 'designer' }, 'nr_q_b')

    const qCtxA = await buildPromptContext({
      db: dbA,
      definition: defA,
      taskId: 'task_A',
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    const qCtxB = await buildPromptContext({
      db: dbB,
      definition: defB,
      taskId: 'task_B',
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    expect(qCtxA).toBeDefined()
    expect(qCtxB).toBeDefined()
    expect(qCtxA!.questionsBlock).toBe(qCtxB!.questionsBlock)
    expect(qCtxA!.answersBlock).toBe(qCtxB!.answersBlock)
    expect(qCtxA!.directive).toBe(qCtxB!.directive)
  })

  test('questioner cascade rerun — reject path: no questionScopes vs all-designer (both still get full Q&A + stop directive)', async () => {
    const dbA = createInMemoryDb(MIGRATIONS)
    const dbB = createInMemoryDb(MIGRATIONS)
    const defA = await seedTask(dbA, 'task_A')
    const defB = await seedTask(dbB, 'task_B')

    async function rejectSubmit(
      db: DbClient,
      taskId: string,
      scopes: Record<string, ClarifyQuestionScope> | undefined,
      questionerRunId: string,
    ): Promise<void> {
      await db.insert(nodeRuns).values({
        id: questionerRunId,
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        startedAt: Date.now(),
      })
      const { crossClarifyNodeRunId } = await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: 'cc1',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: questionerRunId,
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQ('q1', 'first'), makeQ('q2', 'second')],
      })
      await submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: [],
            customText: '',
          },
          {
            questionId: 'q2',
            selectedOptionIndices: [0],
            selectedOptionLabels: [],
            customText: '',
          },
        ],
        directive: 'stop',
        ...(scopes !== undefined ? { questionScopes: scopes } : {}),
      })
    }
    await rejectSubmit(dbA, 'task_A', undefined, 'nr_q_a')
    await rejectSubmit(dbB, 'task_B', { q1: 'designer', q2: 'designer' }, 'nr_q_b')

    const qCtxA = await buildPromptContext({
      db: dbA,
      definition: defA,
      taskId: 'task_A',
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    const qCtxB = await buildPromptContext({
      db: dbB,
      definition: defB,
      taskId: 'task_B',
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 1,
    })
    expect(qCtxA).toBeDefined()
    expect(qCtxB).toBeDefined()
    expect(qCtxA!.questionsBlock).toBe(qCtxB!.questionsBlock)
    expect(qCtxA!.answersBlock).toBe(qCtxB!.answersBlock)
    expect(qCtxA!.directive).toBe('stop')
    expect(qCtxB!.directive).toBe('stop')
  })
})
