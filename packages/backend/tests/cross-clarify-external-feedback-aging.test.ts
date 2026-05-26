// RFC-064 follow-up — designer-side External Feedback aging gap.
//
// Why this test exists: RFC-064 §3.4 declared the GENERAL aging rule
// (`computeHistoryCutoff` → drop rounds whose iteration is already baked
// into a prior done node_run with `node_run_outputs`) unified across BOTH
// consumer paths under the merged `clarifyIteration` counter. §5.5 wired
// the cutoff into the self + cross-questioner branches at scheduler.ts
// :1582-1606, but DID NOT thread it into `buildExternalFeedbackContext`.
// Result: once the designer has produced a normal <workflow-output> that
// captured the cross-clarify Q&A, any later rerun (review-iterate /
// process-retry / freshness invariant top-up) keeps re-injecting the same
// cross-clarify Q&A into the External Feedback block — wasting tokens and
// re-anchoring the agent on decisions it already ingested. Live failure:
// task 01KSHDCASXA5GDKN3KDZVXYYT0 (cross-clarify iter=1 answered before
// designer's `01KSHF93REQ0WAXSJPXPJMN3WF` done run with clarifyIteration=5
// + outputs; the next rerun would still see iter=1 in External Feedback).
//
// This file locks the fix: `buildExternalFeedbackContext` MUST accept a
// `historyCutoff?: number` parameter and drop any cross-clarify source
// whose round iteration is < cutoff. Scheduler.ts feeds it the same
// `historyCutoffClarifyIteration` (from `computeHistoryCutoff`) that the
// self + cross-questioner branches already consume, so a single source of
// truth covers all three consumer kinds — closing the last gap RFC-064
// §3.4 intended to close.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildExternalFeedbackContext,
  createCrossClarifySession,
  submitCrossClarifyAnswers,
} from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type {
  ClarifyAnswer,
  ClarifyQuestion,
  WorkflowDefinition,
  WorkflowNode,
} from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
    { id: 'cc1', kind: 'clarify-cross-agent', title: 'cc1' } as WorkflowNode,
  ]
  const def: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes,
    edges: [
      {
        id: 'e_q_cc1',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cc1', portName: 'questions' },
      },
      {
        id: 'e_d_cc1',
        source: { nodeId: 'cc1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
      {
        id: 'e_qb_cc1',
        source: { nodeId: 'cc1', portName: 'to_questioner' },
        target: { nodeId: 'questioner', portName: '__clarify_response__' },
      },
    ],
    outputs: [],
  }
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
    name: 'fixture',
    id: taskId,
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-aging-test/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition: def }
}

function makeQuestion(overrides: Partial<ClarifyQuestion> = {}): ClarifyQuestion {
  return {
    id: 'q1',
    title: 'Which database?',
    kind: 'single',
    recommended: false,
    options: [
      { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
      { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
    ],
    ...overrides,
  }
}

function makeAnswer(overrides: Partial<ClarifyAnswer> = {}): ClarifyAnswer {
  return {
    questionId: 'q1',
    selectedOptionIndices: [0],
    selectedOptionLabels: [],
    customText: '',
    ...overrides,
  }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-064 follow-up — buildExternalFeedbackContext historyCutoff aging', () => {
  test('drops cross-clarify source whose iteration < cutoff (baked-in by a prior done designer run with outputs)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)

    // Questioner run that emitted the original cross-clarify envelope.
    await db.insert(nodeRuns).values({
      id: 'nr_q_done',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    // Designer's most recent done run with outputs at clarifyIteration=5 —
    // mirrors live task 01KSHDCASXA5GDKN3KDZVXYYT0 row
    // `01KSHF93REQ0WAXSJPXPJMN3WF`. Must exist BEFORE the submit calls below
    // so `triggerDesignerRerun` can find a prior designer row to clone.
    await db.insert(nodeRuns).values({
      id: 'nr_designer_done',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 6,
      iteration: 0,
      clarifyIteration: 5,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_designer_done',
      portName: 'docpath',
      content: '/tmp/aw/output.md',
    })

    // Cross-clarify iter=1 — answered + continue. (We mint iter=0 then iter=1
    // so the second session lands at iteration=1, matching the live failure.)
    for (let i = 0; i < 2; i++) {
      const { crossClarifyNodeRunId } = await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: 'cc1',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q_done',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQuestion({ title: `cross-clarify question round ${i}` })],
      })
      await submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAnswer()],
        directive: 'continue',
        ifMatchIteration: i,
      })
    }

    // Designer about to rerun at clarifyIteration=6. Without cutoff, the
    // External Feedback block would still pull iter=1 (the latest answered
    // continue session) and re-inject it — wasting tokens + re-anchoring
    // the agent. With cutoff=5 (RFC-064 GENERAL rule, computed from the
    // prior done run's clarifyIteration), iter=1 must be dropped because
    // round.iteration=1 < cutoff=5 — already baked into the prior output.
    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerClarifyIteration: 6,
      definition,
      historyCutoff: 5,
    })
    expect(ctx).toBeUndefined()
  })

  test('keeps cross-clarify source whose iteration >= cutoff (fresh round not yet baked in)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)

    await db.insert(nodeRuns).values({
      id: 'nr_q_done',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    // Prior done designer run at clarifyIteration=1 — iter=0 was baked in,
    // iter=1 has NOT been ingested yet. cutoff=1 keeps iter=1 (>=1). Seeded
    // before submits so `triggerDesignerRerun` finds a prior row to clone.
    await db.insert(nodeRuns).values({
      id: 'nr_designer_done',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 1,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_designer_done',
      portName: 'docpath',
      content: '/tmp/aw/output.md',
    })

    // Two cross-clarify sessions: iter=0 and iter=1. iter=1 is the standing
    // round the designer must still address.
    for (let i = 0; i < 2; i++) {
      const { crossClarifyNodeRunId } = await createCrossClarifySession({
        db,
        taskId,
        crossClarifyNodeId: 'cc1',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q_done',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        questions: [makeQuestion({ title: `fresh round ${i}` })],
      })
      await submitCrossClarifyAnswers({
        db,
        crossClarifyNodeRunId,
        answers: [makeAnswer()],
        directive: 'continue',
        ifMatchIteration: i,
      })
    }

    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerClarifyIteration: 2,
      definition,
      historyCutoff: 1,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.block).toContain('fresh round 1')
  })

  test('historyCutoff=undefined is a no-op — surfaces latest answered source (legacy behaviour)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)

    await db.insert(nodeRuns).values({
      id: 'nr_q_done',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    // Designer placeholder so `triggerDesignerRerun` has a row to clone on submit.
    await db.insert(nodeRuns).values({
      id: 'nr_designer_first',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      startedAt: Date.now() - 100,
      finishedAt: Date.now() - 50,
    })
    const { crossClarifyNodeRunId } = await createCrossClarifySession({
      db,
      taskId,
      crossClarifyNodeId: 'cc1',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_done',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      questions: [makeQuestion({ title: 'first round question' })],
    })
    await submitCrossClarifyAnswers({
      db,
      crossClarifyNodeRunId,
      answers: [makeAnswer()],
      directive: 'continue',
      ifMatchIteration: 0,
    })

    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerClarifyIteration: 1,
      definition,
      // historyCutoff omitted on purpose — preserves the pre-fix call shape
      // for any callsite that hasn't yet been wired to pass a cutoff.
    })
    expect(ctx?.block).toContain('first round question')
  })
})
