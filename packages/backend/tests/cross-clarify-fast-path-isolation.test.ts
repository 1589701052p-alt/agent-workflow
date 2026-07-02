// RFC-059 C4 (slimmed by RFC-132) — a questioner-scope sibling resolution must not
// block (or feed) the designer.
//
// The original file locked the RFC-059 "fast path" (the retired legacy immediate
// questioner mint). RFC-132 unified all answers onto autoDispatchClarifyRound —
// per-round seal isolation, the questioner-scope "no designer entry" rule, scope-JSON
// dual-write parity and the questioner continuation mint are now locked by
// cross-clarify-multi-source-wait.test.ts, cross-clarify-question-scope.test.ts and
// rfc128-p5-d-autodispatch.test.ts. The ONE invariant not covered there survives here:
//
//   Peer A resolves its round with ALL-QUESTIONER scope (continue). Peer B (same
//   designer) then answers with designer-scoped questions. The designer readiness
//   must treat A as RESOLVED (answered, nothing to feed) — B's answer alone fires
//   exactly one designer rerun; A contributes no designer entry to the batch.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, taskQuestions, tasks, workflows } from '../src/db/schema'
import { autoDispatchClarifyRound } from '../src/services/clarifyAutoDispatch'
import { createCrossClarifySession } from '../src/services/crossClarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { ClarifyQuestion, WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const actor = { userId: 'u1', role: 'owner' as const }

async function seedTwoSource(db: DbClient): Promise<{ taskId: string; def: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const nodes: WorkflowNode[] = [
    { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
    { id: 'q_a', kind: 'agent-single', agentName: 'q_a' } as WorkflowNode,
    { id: 'q_b', kind: 'agent-single', agentName: 'q_b' } as WorkflowNode,
    { id: 'cc_a', kind: 'clarify-cross-agent', title: 'cc_a' } as WorkflowNode,
    { id: 'cc_b', kind: 'clarify-cross-agent', title: 'cc_b' } as WorkflowNode,
  ]
  const edges: WorkflowDefinition['edges'] = []
  for (const pair of [
    { q: 'q_a', cc: 'cc_a' },
    { q: 'q_b', cc: 'cc_b' },
  ]) {
    edges.push({
      id: `e_q_${pair.cc}`,
      source: { nodeId: pair.q, portName: '__clarify__' },
      target: { nodeId: pair.cc, portName: 'questions' },
    })
    edges.push({
      id: `e_d_${pair.cc}`,
      source: { nodeId: pair.cc, portName: 'to_designer' },
      target: { nodeId: 'designer', portName: '__external_feedback__' },
    })
    edges.push({
      id: `e_qb_${pair.cc}`,
      source: { nodeId: pair.cc, portName: 'to_questioner' },
      target: { nodeId: pair.q, portName: '__clarify_response__' },
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
    name: 'rfc-059-c4',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc-059-c4',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc-059-c4/repo',
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
  return { taskId, def }
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

async function spawnSession(
  db: DbClient,
  taskId: string,
  args: {
    questionerNodeId: string
    questionerRunId: string
    ccNodeId: string
    questions: ClarifyQuestion[]
  },
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: args.questionerRunId,
    taskId,
    nodeId: args.questionerNodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    startedAt: Date.now(),
  })
  const { crossClarifyNodeRunId } = await createCrossClarifySession({
    db,
    taskId,
    crossClarifyNodeId: args.ccNodeId,
    sourceQuestionerNodeId: args.questionerNodeId,
    sourceQuestionerNodeRunId: args.questionerRunId,
    targetDesignerNodeId: 'designer',
    loopIter: 0,
    questions: args.questions,
  })
  return crossClarifyNodeRunId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-059 C4 — questioner-scope sibling resolution unblocks the designer', () => {
  test('peer A all-questioner + B all-designer → the designer rerun fires from B alone', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTwoSource(db)
    const aRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_a',
      questionerRunId: 'nr_q_a',
      ccNodeId: 'cc_a',
      questions: [mkQ('a1', 'a-first')],
    })
    const bRunId = await spawnSession(db, taskId, {
      questionerNodeId: 'q_b',
      questionerRunId: 'nr_q_b',
      ccNodeId: 'cc_b',
      questions: [mkQ('b1', 'b-first')],
    })
    // Peer A answers all-questioner: its questioner continuation mints; NO designer
    // entry is created for A (questioner scope) and the designer must NOT rerun yet.
    const aResult = await autoDispatchClarifyRound({
      db,
      originNodeRunId: aRunId,
      answers: [
        { questionId: 'a1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      scopes: { a1: 'questioner' },
      actor,
    })
    expect(aResult.dispatch.reruns.some((r) => r.targetNodeId === 'designer')).toBe(false)
    const aEntries = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, aRunId))
    expect(aEntries.some((e) => e.roleKind === 'designer')).toBe(false)
    expect((await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))).length).toBe(1)

    // Peer B answers all-designer: A reads as RESOLVED (answered) in the readiness
    // scan, so B's answer alone dispatches the designer — exactly one rerun, carrying
    // only B's designer entry (A never produced one).
    const bResult = await autoDispatchClarifyRound({
      db,
      originNodeRunId: bRunId,
      answers: [
        { questionId: 'b1', selectedOptionIndices: [0], selectedOptionLabels: [], customText: '' },
      ],
      scopes: { b1: 'designer' },
      actor,
    })
    const designerRerun = bResult.dispatch.reruns.find((r) => r.targetNodeId === 'designer')
    expect(designerRerun).toBeDefined()
    expect(designerRerun!.entryIds).toHaveLength(1)
    const designerRuns = await db.select().from(nodeRuns).where(eq(nodeRuns.nodeId, 'designer'))
    expect(designerRuns.length).toBe(2) // initial done + new rerun
  })
})
