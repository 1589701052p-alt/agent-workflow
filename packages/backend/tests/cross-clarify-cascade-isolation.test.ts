// RFC-056 PR-D C8 — self+cross cascade isolation 守门.
//
// When the same task has BOTH a self-clarify (RFC-023) and a cross-clarify
// (RFC-056) feedback channel targeting the same designer agent, the two
// iteration counters (clarify_iteration / cross_clarify_iteration) must
// stay orthogonal: a cross-clarify rerun preserves the prior
// clarify_iteration value (no demotion of self-clarify history); a
// self-clarify rerun preserves the prior cross_clarify_iteration.
//
// The prompt renderer must also produce both `## Clarify Q&A` (RFC-023)
// and `## External Feedback` (RFC-056) blocks in the documented order
// without one overwriting the other.
//
// LOCKS:
//   1. triggerDesignerRerun on a designer at (clarifyIteration=2,
//      crossClarifyIteration=3) mints a new row at (clarifyIteration=2,
//      crossClarifyIteration=4) — cross bumps, self preserved.
//   2. Same starting state, but if a self-clarify rerun were triggered
//      (simulated by a node_run insert mirroring RFC-023's contract), it
//      would mint (clarifyIteration=3, crossClarifyIteration=3) — self
//      bumps, cross preserved. (We verify the cross-clarify side does NOT
//      block this by checking the columns are independent — no shared
//      mutation, no constraint coupling.)
//   3. renderUserPrompt with BOTH a clarifyContext (RFC-023) and a
//      crossClarifyContext (RFC-056) emits both blocks in order:
//      `## Clarify Q&A` comes before `## External Feedback`.
//   4. The `crossClarifyContext.iteration` value and the rendered designer
//      cross_clarify_iteration are independent — bumping one does not
//      shift the other in the prompt.
//
// If any of these go red the self/cross orthogonality contract drifted —
// investigate before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq, gt } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
import { renderUserPrompt } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createCrossClarifySession, submitCrossClarifyAnswers } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function makeQ(id: string): ClarifyQuestion {
  return {
    id,
    title: `Question ${id}`,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function makeAns(qid: string): ClarifyAnswer {
  return { questionId: qid, selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' }
}

function mixedDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'selfClarify', kind: 'clarify', title: 'Self Clarify' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      // RFC-023 self-clarify channel
      {
        id: 'e_d_self_ask',
        source: { nodeId: 'designer', portName: '__clarify__' },
        target: { nodeId: 'selfClarify', portName: 'questions' },
      },
      {
        id: 'e_self_d_ans',
        source: { nodeId: 'selfClarify', portName: 'answers' },
        target: { nodeId: 'designer', portName: '__clarify_response__' },
      },
      // RFC-056 cross-clarify channel
      {
        id: 'e_q_cross',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_cross_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = mixedDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'mix',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc056-c8',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedQRun(db: DbClient, taskId: string, nodeId: string): Promise<string> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 6)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
    crossClarifyIteration: 0,
  })
  return id
}

async function seedDesignerAt(
  db: DbClient,
  taskId: string,
  clarifyIteration: number,
  crossClarifyIteration: number,
): Promise<string> {
  const id = `nr_d_${clarifyIteration}_${crossClarifyIteration}_${Math.random().toString(36).slice(2, 6)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: 'designer',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration,
    crossClarifyIteration,
    preSnapshot: 'snap-c8',
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 C8 — self+cross cascade isolation', () => {
  test('cross-clarify rerun preserves prior clarify_iteration; only crossClarifyIteration bumps', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Designer at clarifyIteration=2, crossClarifyIteration=3 — i.e. mixed history.
    await seedDesignerAt(db, taskId, 2, 3)
    const qRun = await seedQRun(db, taskId, 'questioner')
    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    const ret = await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    expect(ret.outcome.kind).toBe('designer-rerun-triggered')
    if (ret.outcome.kind !== 'designer-rerun-triggered') return

    const newDesigner = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, ret.outcome.designerNodeRunId))
    )[0]
    expect(newDesigner?.clarifyIteration).toBe(2) // self preserved
    expect(newDesigner?.crossClarifyIteration).toBe(4) // cross bumped
  })

  test('iteration columns are independently writable — schema does not couple them', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Insert a designer row with high clarifyIteration but zero crossClarify
    // (simulating self-clarify-only history).
    await seedDesignerAt(db, taskId, 5, 0)
    // Insert a designer row with zero clarifyIteration but high crossClarify
    // (simulating cross-clarify-only history).
    await seedDesignerAt(db, taskId, 0, 5)
    const rows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    expect(rows.length).toBe(2)
    const sortedByClarify = [...rows].sort((a, b) => a.clarifyIteration - b.clarifyIteration)
    expect(sortedByClarify[0]?.clarifyIteration).toBe(0)
    expect(sortedByClarify[0]?.crossClarifyIteration).toBe(5)
    expect(sortedByClarify[1]?.clarifyIteration).toBe(5)
    expect(sortedByClarify[1]?.crossClarifyIteration).toBe(0)
  })

  test('cross-clarify rerun does NOT mint a row that shares the prior crossClarifyIteration (no duplicate-iter race)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedDesignerAt(db, taskId, 0, 3)
    const qRun = await seedQRun(db, taskId, 'questioner')
    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })
    const elevatedDesigner = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.nodeId, 'designer'), gt(nodeRuns.crossClarifyIteration, 3)))
    expect(elevatedDesigner.length).toBe(1)
    expect(elevatedDesigner[0]?.crossClarifyIteration).toBe(4)
  })

  test('renderUserPrompt emits both ## Clarify Q&A and ## External Feedback blocks in documented order', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Designer body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      clarifyContext: {
        questionsBlock: '### Q1: pick DB\n- Type: single',
        answersBlock: '### Q1: pick DB\n- User chose: "Postgres"',
        iteration: '2',
      },
      crossClarifyContext: {
        block: "### From 'auditor' (round 4)\n\n#### Q1: foo\n- bar",
        iteration: '4',
        sourcesCsv: 'auditor',
      },
    })
    const clarifyIdx = out.indexOf('## Clarify Q&A')
    const externalIdx = out.indexOf('## External Feedback')
    expect(clarifyIdx).toBeGreaterThan(-1)
    expect(externalIdx).toBeGreaterThan(-1)
    expect(externalIdx).toBeGreaterThan(clarifyIdx)
  })

  test('crossClarifyContext.iteration value (cross_clarify_iteration) is rendered independently of clarify_iteration', () => {
    const outA = renderUserPrompt({
      promptTemplate:
        'cross={{__external_feedback_iteration__}} self={{__self_clarify_iteration__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      clarifyContext: {
        questionsBlock: '',
        answersBlock: '',
        iteration: '1',
      },
      crossClarifyContext: { block: '', iteration: '7', sourcesCsv: '' },
    })
    expect(outA).toContain('cross=7')

    const outB = renderUserPrompt({
      promptTemplate: 'cross={{__external_feedback_iteration__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: { block: '', iteration: '7', sourcesCsv: '' },
    })
    // Same iteration value rendered identically regardless of whether
    // clarifyContext is present.
    expect(outB.startsWith('cross=7')).toBe(true)
  })
})
