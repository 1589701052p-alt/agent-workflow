// RFC-056 patch 2026-05-23 — designer's own pending row uses max(existing)+1.
//
// The 2026-05-22 cascade patch correctly bumped retry_index on every
// DOWNSTREAM cascade row (`cascadeDownstreamFromDesigner` uses
// `Math.max(existing retry_index) + 1` so the new pending always beats any
// prior done under `isFresherNodeRun`). But the same fix was NOT applied to
// the DESIGNER's own new pending row in `triggerDesignerRerun` —
// retry_index there was hardcoded to 0.
//
// Live task `01KS86DPCSERV7S41GQA5Y81RN` (workflow 01KS7C0K5ZRJ29AZD7J13C42C2
// "跨节点反问") hit this: designer ran many RFC-023 self-clarify rounds +
// RFC-042 same-session retries, pushing its latest done row to
// `clarify_iteration=6, retry_index=9`. After the user submitted the cross-
// clarify continue, the new pending designer row was minted at
// `clarify_iteration=6, retry_index=0`. `isFresherNodeRun` keys on
// `(clarifyIteration, retryIndex, id)` — NOT `crossClarifyIteration` — so
// the old done row (retry=9) beat the new pending (retry=0). The scheduler
// treated the designer as "completed", never dispatched the new row, and
// only the questioner's cascade-minted row (which DOES use max+1) ran.
// Observable symptom: "designer never re-executes after cross-clarify
// submit — only the questioner re-executes."
//
// This file locks the FIX: the designer's own new pending row carries
// retry_index strictly greater than every existing top-level row's
// retry_index at the same wrapper-loop iteration. If this test goes red,
// the freshness shield is gone — investigate before relaxing.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { ClarifyAnswer, ClarifyQuestion, WorkflowDefinition } from '@agent-workflow/shared'
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

function fixtureDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
      {
        id: 'e_d_q',
        source: { nodeId: 'designer', portName: 'docpath' },
        target: { nodeId: 'questioner', portName: 'requirement' },
      },
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
      {
        id: 'e_cross_q',
        source: { nodeId: 'cross1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = fixtureDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'designer-retry-index',
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
    repoPath: '/tmp/aw-designer-retry-index',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert>,
): Promise<string> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 10)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
    crossClarifyIteration: 0,
    ...fields,
  })
  return id
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 patch 2026-05-23 — designer rerun retry_index bump', () => {
  test('designer prior retry_index=9 (self-clarify storm) — new pending row strictly beats it', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // Mirror the live failure shape: designer ran many self-clarify rounds
    // + same-session retries, leaving its latest done at clarify_iter=6,
    // retry_index=9. Seed a handful of prior failed/done attempts so the
    // max-retry bump must walk all of them.
    await seedRun(db, taskId, 'in', {})
    await seedRun(db, taskId, 'designer', {
      status: 'failed',
      retryIndex: 7,
      clarifyIteration: 6,
    })
    await seedRun(db, taskId, 'designer', {
      status: 'interrupted',
      retryIndex: 8,
      clarifyIteration: 6,
    })
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      retryIndex: 9,
      clarifyIteration: 6,
      preSnapshot: 'snap-d',
    })
    const qRun = await seedRun(db, taskId, 'questioner', { retryIndex: 2 })

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

    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    const designerPending = designerRows.find((r) => r.status === 'pending')
    expect(designerPending, 'a pending designer row must be minted').toBeDefined()
    expect(designerPending?.crossClarifyIteration).toBe(1)
    expect(designerPending?.clarifyIteration).toBe(6)
    // The freshness shield: retry_index must beat every prior row at the
    // same (node, iteration). `isFresherNodeRun` ties on clarifyIteration
    // (both 6), so retry_index alone decides.
    expect(designerPending?.retryIndex).toBeGreaterThan(9)
  })

  test('designer first-ever rerun (no prior retries) — new pending retry_index=1', async () => {
    // No clarify storm: prior designer ran exactly once at retry_index=0.
    // The bump must still produce a strictly greater retry_index so the
    // contract is invariant w.r.t. the prior retry depth.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', { retryIndex: 0, preSnapshot: 'snap-d' })
    const qRun = await seedRun(db, taskId, 'questioner', { retryIndex: 0 })

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

    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    const pending = designerRows.find((r) => r.status === 'pending')
    expect(pending?.retryIndex).toBe(1)
  })

  test('only same-iteration rows count toward the bump (wrapper-loop isolation)', async () => {
    // Designer ran twice at iteration=0 (retry 0, 5) then once at
    // iteration=1 (retry 0). A cross-clarify resolve at iteration=1 must
    // bump retry_index off iteration=1's max only — not iteration=0's.
    // startedAt is explicitly set in ascending order so `lastDesigner`
    // (picked via ORDER BY started_at DESC) resolves to the iteration=1
    // row deterministically.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRun(db, taskId, 'designer', { iteration: 0, retryIndex: 0, startedAt: 100 })
    await seedRun(db, taskId, 'designer', { iteration: 0, retryIndex: 5, startedAt: 200 })
    await seedRun(db, taskId, 'designer', {
      iteration: 1,
      retryIndex: 0,
      preSnapshot: 'snap-d-iter1',
      startedAt: 300,
    })
    const qRun = await seedRun(db, taskId, 'questioner', {
      iteration: 1,
      retryIndex: 0,
      startedAt: 400,
    })

    const sess = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cross1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: qRun,
      targetDesignerNodeId: 'designer',
      loopIter: 1,
      questions: [makeQ('q1')],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId: sess.crossClarifyNodeRunId,
      answers: [makeAns('q1')],
      directive: 'continue',
    })

    const designerRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'designer')))
    // The fresh pending is the only row at iteration=1 with status=pending.
    const pending = designerRows.find((r) => r.status === 'pending' && r.iteration === 1)
    expect(pending).toBeDefined()
    // Bump off iteration=1's max (=0), NOT iteration=0's max (=5).
    expect(pending?.retryIndex).toBe(1)
    // Iteration=0 rows untouched.
    const iter0Rows = designerRows.filter((r) => r.iteration === 0)
    expect(iter0Rows.length).toBe(2)
  })
})
