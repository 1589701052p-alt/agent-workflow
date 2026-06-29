// RFC-070 — locks in clarify aging behavior under "consumed-by-run-id" stamp
// model (proposal.md §1, design.md §3-§4).
//
// Why these tests exist:
//   - The aging cutoff was previously a numeric `iteration < cutoff` compare
//     between two counters that drifted apart (RFC-064 §3.4 unified one side
//     but not cross-clarify session iteration). Eight dated patches across
//     2026-05-22 ~ 05-27 all addressed "which counter to read" without ever
//     questioning the counter model itself. The most recent failure:
//     task `01KSHDCASXA5GDKN3KDZVXYYT0` had cross-clarify iter=2 dropped
//     from the designer rerun's prompt because cutoff=5 (clarifyIteration
//     from a prior done) > 2 (cross-local iteration counter).
//   - RFC-070 replaces the comparison with a row-level state: each Q&A row
//     carries a `consumed_by_consumer_run_id` / `consumed_by_questioner_run_id`
//     stamp; aging = "WHERE consumed IS NULL". Zero math, no counter
//     alignment burden, structurally closes the entire bug class.
//
// If any of these cases turns red:
//   - DO NOT relax assertions to make them pass.
//   - The whole point of RFC-070 is that this aging rule cannot silently
//     drift; a red test means a real regression. Trace back to the mark
//     helper (markClarifyRoundsConsumedBy) call site, or the aging SELECT
//     predicate (isNull(...consumedBy...)).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq, isNull } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  clarifyRounds,
  clarifySessions,
  crossClarifySessions,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import {
  buildPromptContext,
  markClarifyRoundsConsumedBy,
  selectAnsweredRoundsForConsumer,
} from '../src/services/clarifyRounds'
import { buildExternalFeedbackContext } from '../src/services/crossClarify'
import { buildClarifyPromptContext } from '../src/services/clarify'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

function emptyDefinition(): WorkflowDefinition {
  return {
    $schema_version: 1,
    version: 1,
    nodes: [],
    edges: [],
    inputs: { ports: [] },
    outputs: { ports: [] },
  } as unknown as WorkflowDefinition
}

async function seedTask(db: DbClient): Promise<{ taskId: string }> {
  const taskId = 'task_rfc070'
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'RFC-070',
    description: '',
    definition: JSON.stringify(emptyDefinition()),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    workflowId,
    name: 'RFC-070 aging stamp behavior',
    status: 'running',
    repoPath: '/tmp/rfc070-repo',
    baseBranch: 'main',
    worktreePath: '/tmp/rfc070-worktree',
    branch: 'agent-workflow/task_rfc070',
    inputs: '{}',
    startedAt: Date.now(),
    workflowSnapshot: JSON.stringify(emptyDefinition()),
  })
  return { taskId }
}

function questionsJson(title: string): string {
  return JSON.stringify([
    {
      id: 'q1',
      title,
      kind: 'single',
      options: [
        { label: 'a', description: 'opt a' },
        { label: 'b', description: 'opt b' },
      ],
    },
  ])
}
function answersJson(): string {
  return JSON.stringify([
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['a'],
      customText: '',
    },
  ])
}

// ---------------------------------------------------------------------------
// B1 — eventgenic incident (task 01KSHDCASXA5GDKN3KDZVXYYT0): cross iter=2 with
// per-(node, loopIter) local counter must NOT be aged out when the unified
// designer clarifyIteration is 5+ from intervening self-clarify rounds.
// ---------------------------------------------------------------------------

describe('RFC-070 B1 — incident reproducer (cross iter local counter < unified clarifyIteration)', () => {
  test('latest cross iter=2 survives even though designer clarifyIteration reached 5', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // Designer has multiple prior done runs with outputs — under the OLD
    // iteration-cutoff model this would produce cutoff=5 (the prior done's
    // unified clarifyIteration) and incorrectly drop the cross row iter=2.
    // Under RFC-070, those prior dones each stamped consumed rows at their
    // respective time; the latest cross iter=2 was answered AFTER all of
    // them and therefore has NO consumed stamp yet → must surface.
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d_ci5_done',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 6,
        iteration: 0,
        startedAt: 1779776655000,
        finishedAt: 1779776850000,
      },
      {
        id: 'nr_d_ci6_pending',
        taskId,
        nodeId: 'designer',
        status: 'pending',
        retryIndex: 7,
        iteration: 0,
        startedAt: 1779783865188,
      },
      {
        id: 'nr_q',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_cc',
        taskId,
        nodeId: 'cross_clarify_6c910f',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    // Three cross-clarify sessions: iter=0 + iter=1 consumed by prior done
    // (ci=5), iter=2 answered AFTER the ci=5 done finished → not yet consumed.
    await db.insert(crossClarifySessions).values([
      {
        id: 'ccs_0',
        taskId,
        crossClarifyNodeId: 'cross_clarify_6c910f',
        crossClarifyNodeRunId: 'nr_cc',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('iter-0 question'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 1779774000000,
        consumedByConsumerRunId: 'nr_d_ci5_done', // baked in
      },
      {
        id: 'ccs_1',
        taskId,
        crossClarifyNodeId: 'cross_clarify_6c910f',
        crossClarifyNodeRunId: 'nr_cc',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        iteration: 1,
        questionsJson: questionsJson('iter-1 question'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 1779776500000,
        consumedByConsumerRunId: 'nr_d_ci5_done', // baked in
      },
      {
        id: 'ccs_2',
        taskId,
        crossClarifyNodeId: 'cross_clarify_6c910f',
        crossClarifyNodeRunId: 'nr_cc',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        iteration: 2,
        questionsJson: questionsJson('iter-2 question'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 1779783865143,
        consumedByConsumerRunId: null, // NOT YET CONSUMED — the live one
      },
    ])
    const definition = {
      $schema_version: 1,
      version: 1,
      nodes: [
        { id: 'designer', kind: 'agent-single' },
        { id: 'cross_clarify_6c910f', kind: 'clarify-cross-agent' },
        { id: 'questioner', kind: 'agent-single' },
      ],
      edges: [
        {
          source: { nodeId: 'cross_clarify_6c910f', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      inputs: { ports: [] },
      outputs: { ports: [] },
    } as unknown as WorkflowDefinition

    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerGeneration: 6,
      definition,
    })
    // Under the OLD bug: ctx would be undefined (cross iter=2 dropped by
    // iteration cutoff=5). Under RFC-070: ctx is defined and contains the
    // iter-2 question.
    expect(ctx).toBeDefined()
    expect(ctx?.block).toContain('iter-2 question')
  })
})

// ---------------------------------------------------------------------------
// B2 — multi-self dressed-between-cross: self-clarify rounds between two
// cross-clarify rounds must not push the cross out of the prompt.
// ---------------------------------------------------------------------------

describe('RFC-070 B2 — multi self-clarify between cross-clarify rounds (no false-aging)', () => {
  test('older cross iter=0 is aged out, newer cross iter=1 (answered after intervening self+done) survives', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d_early_done',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
        finishedAt: 200,
      },
      {
        id: 'nr_q',
        taskId,
        nodeId: 'questioner',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_cc',
        taskId,
        nodeId: 'cc1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(crossClarifySessions).values([
      {
        id: 'older',
        taskId,
        crossClarifyNodeId: 'cc1',
        crossClarifyNodeRunId: 'nr_cc',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('old cross Q'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 100,
        consumedByConsumerRunId: 'nr_d_early_done',
      },
      {
        id: 'newer',
        taskId,
        crossClarifyNodeId: 'cc1',
        crossClarifyNodeRunId: 'nr_cc',
        sourceQuestionerNodeId: 'questioner',
        sourceQuestionerNodeRunId: 'nr_q',
        targetDesignerNodeId: 'designer',
        loopIter: 0,
        iteration: 1,
        questionsJson: questionsJson('new cross Q'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 300,
        consumedByConsumerRunId: null,
      },
    ])
    const def = {
      $schema_version: 1,
      version: 1,
      nodes: [
        { id: 'designer', kind: 'agent-single' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      edges: [
        {
          source: { nodeId: 'cc1', portName: 'to_designer' },
          target: { nodeId: 'designer', portName: '__external_feedback__' },
        },
      ],
      inputs: { ports: [] },
      outputs: { ports: [] },
    } as unknown as WorkflowDefinition

    const ctx = await buildExternalFeedbackContext({
      db,
      taskId,
      designerNodeId: 'designer',
      loopIter: 0,
      designerGeneration: 4,
      definition: def,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.block).toContain('new cross Q')
    expect(ctx?.block).not.toContain('old cross Q')
  })
})

// ---------------------------------------------------------------------------
// B3 — review-iterate rerun reads consumed-by stamp; doesn't replay baked-in
// Q&A.
// ---------------------------------------------------------------------------

describe('RFC-070 B3 — review-iterate rerun does not replay consumed self-clarify rounds', () => {
  test('self-clarify row stamped consumed_by_consumer_run_id drops out of buildPromptContext', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d_done', taskId, nodeId: 'd', status: 'done' },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_consumed',
        taskId,
        kind: 'self',
        askingNodeId: 'd',
        askingNodeRunId: 'nr_d_done',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_c',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('Q-consumed'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        consumedByConsumerRunId: 'nr_d_done',
      },
      {
        id: 'r_fresh',
        taskId,
        kind: 'self',
        askingNodeId: 'd',
        askingNodeRunId: 'nr_d_done',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_c',
        loopIter: 0,
        iteration: 1,
        questionsJson: questionsJson('Q-fresh'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        consumedByConsumerRunId: null,
      },
    ])
    const ctx = await buildPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'd',
      targetIteration: 5,
      shardKey: null,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).not.toContain('Q-consumed')
    expect(ctx?.questionsBlock).toContain('Q-fresh')
  })
})

// ---------------------------------------------------------------------------
// B4 — legacy clarify.ts buildClarifyPromptContext also reads consumed stamp.
// ---------------------------------------------------------------------------

describe('RFC-070 B4 — legacy buildClarifyPromptContext respects consumed stamp', () => {
  test('clarify_sessions row stamped consumed_by_consumer_run_id drops out', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_c', taskId, nodeId: 'clarify1', status: 'done' },
    ])
    await db.insert(clarifySessions).values([
      {
        id: 'sess_consumed',
        taskId,
        sourceAgentNodeId: 'designer',
        sourceAgentNodeRunId: 'nr_d',
        sourceShardKey: null,
        clarifyNodeId: 'clarify1',
        clarifyNodeRunId: 'nr_c',
        iterationIndex: 0,
        questionsJson: questionsJson('consumed Q'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 1,
        consumedByConsumerRunId: 'nr_d',
      },
      {
        id: 'sess_fresh',
        taskId,
        sourceAgentNodeId: 'designer',
        sourceAgentNodeRunId: 'nr_d',
        sourceShardKey: null,
        clarifyNodeId: 'clarify1',
        clarifyNodeRunId: 'nr_c',
        iterationIndex: 1,
        questionsJson: questionsJson('fresh Q'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        answeredAt: 2,
        consumedByConsumerRunId: null,
      },
    ])
    const ctx = await buildClarifyPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      agentNodeId: 'designer',
      targetIteration: 5,
      shardKey: null,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).not.toContain('consumed Q')
    expect(ctx?.questionsBlock).toContain('fresh Q')
  })
})

// ---------------------------------------------------------------------------
// B5 — cross-questioner cascade reads its own consumed stamp.
// ---------------------------------------------------------------------------

describe('RFC-070 B5 — cross-questioner cascade respects consumed_by_questioner_run_id', () => {
  test('rows with questioner stamp drop, fresh rows surface', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_q_done', taskId, nodeId: 'questioner', status: 'done' },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human' },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r0',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q_done',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('q baked'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        consumedByQuestionerRunId: 'nr_q_done',
      },
      {
        id: 'r1',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q_done',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        iteration: 1,
        questionsJson: questionsJson('q fresh'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        consumedByQuestionerRunId: null,
      },
    ])
    const ctx = await buildPromptContext({
      db,
      definition: emptyDefinition(),
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 5,
      loopIter: 0,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).not.toContain('q baked')
    expect(ctx?.questionsBlock).toContain('q fresh')
  })
})

// ---------------------------------------------------------------------------
// B6/B7 — markClarifyRoundsConsumedBy helper semantics.
// ---------------------------------------------------------------------------

// RFC-128 P0 net (behavior #5): 整轮 seal 现状，P1 逐题改造勿破。本 describe 锁住
// 「整轮消费戳」的写入（self→consumer 列 / cross-designer→consumer 列 / cross-questioner
// →questioner 列），done+output 才 stamp 的 gate 由 rfc070-aging-stamp-grep-guards.test.ts
// 「outputsPersistedCount > 0」锁。把这些戳翻译成「该 entry 是否已处理」的整轮门控预言
// （resolveTriggerForEntry：round 非 answered → 无 trigger）补锁见
// rfc128-p0-whole-round-seal-net.test.ts #5。
describe('RFC-070 B6/B7 — markClarifyRoundsConsumedBy stamps every consumer kind', () => {
  test('self path: stamps clarify_rounds (kind=self) and clarify_sessions for matching agent', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d_done', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r1',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_d_done',
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: 'nr_c',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('self Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await db.insert(clarifySessions).values({
      id: 'sess1',
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_d_done',
      sourceShardKey: null,
      clarifyNodeId: 'c1',
      clarifyNodeRunId: 'nr_c',
      iterationIndex: 0,
      questionsJson: questionsJson('self Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_d_done',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    const round = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r1')))[0]!
    const session = (
      await db.select().from(clarifySessions).where(eq(clarifySessions.id, 'sess1'))
    )[0]!
    expect(round.consumedByConsumerRunId).toBe('nr_d_done')
    expect(session.consumedByConsumerRunId).toBe('nr_d_done')
  })

  test('cross-designer path: stamps consumer column on both clarify_rounds and cross_clarify_sessions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d_done', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_q', taskId, nodeId: 'questioner', status: 'done' },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'cr_x',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('cross Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await db.insert(crossClarifySessions).values({
      id: 'ccs_x',
      taskId,
      crossClarifyNodeId: 'cc1',
      crossClarifyNodeRunId: 'nr_cc',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('cross Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_d_done',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    const cr = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'cr_x')))[0]!
    const ccs = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, 'ccs_x'))
    )[0]!
    expect(cr.consumedByConsumerRunId).toBe('nr_d_done')
    expect(cr.consumedByQuestionerRunId).toBeNull()
    expect(ccs.consumedByConsumerRunId).toBe('nr_d_done')
    expect(ccs.consumedByQuestionerRunId).toBeNull()
  })

  test('cross-questioner path: stamps questioner column independent of designer column', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_q_done', taskId, nodeId: 'questioner', status: 'done' },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'cr_y',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q_done',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('cross Q questioner-side'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await db.insert(crossClarifySessions).values({
      id: 'ccs_y',
      taskId,
      crossClarifyNodeId: 'cc1',
      crossClarifyNodeRunId: 'nr_cc',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q_done',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('cross Q questioner-side'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_q_done',
      taskId,
      nodeId: 'questioner',
      shardKey: null,
    })
    const cr = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'cr_y')))[0]!
    const ccs = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, 'ccs_y'))
    )[0]!
    expect(cr.consumedByQuestionerRunId).toBe('nr_q_done')
    expect(cr.consumedByConsumerRunId).toBeNull()
    expect(ccs.consumedByQuestionerRunId).toBe('nr_q_done')
    expect(ccs.consumedByConsumerRunId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// B8 — `IS NULL` predicate prevents double-stamping; first done wins.
// ---------------------------------------------------------------------------

describe('RFC-070 B8 — concurrent mark calls do not overwrite an existing stamp', () => {
  test('second mark call leaves the first run.id in place', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_first', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_second', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_dup',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_first',
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: 'nr_c',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('dup Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_first',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_second',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    const r = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_dup')))[0]!
    expect(r.consumedByConsumerRunId).toBe('nr_first')
  })
})

// ---------------------------------------------------------------------------
// B9 — newly minted rows have NULL stamps.
// ---------------------------------------------------------------------------

describe('RFC-070 B9 — newly minted Q&A rows have consumed_by stamps = NULL', () => {
  test('answered row created post-migration starts with NULL stamps', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({ id: 'nr_d', taskId, nodeId: 'd', status: 'done' })
    await db.insert(clarifyRounds).values({
      id: 'r_new',
      taskId,
      kind: 'self',
      askingNodeId: 'd',
      askingNodeRunId: 'nr_d',
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: 'nr_d',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    const row = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_new')))[0]!
    expect(row.consumedByConsumerRunId).toBeNull()
    expect(row.consumedByQuestionerRunId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// B10 — cross row's designer/questioner stamps are independent.
// ---------------------------------------------------------------------------

describe('RFC-070 B10 — cross row designer + questioner stamps are independent', () => {
  test('designer mark does not stamp questioner column, and vice versa', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_q', taskId, nodeId: 'questioner', status: 'done' },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_x',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    // Designer mark — only consumer column stamped
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_d',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    let r = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_x')))[0]!
    expect(r.consumedByConsumerRunId).toBe('nr_d')
    expect(r.consumedByQuestionerRunId).toBeNull()
    // Then questioner mark — only questioner column stamped, consumer unchanged
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_q',
      taskId,
      nodeId: 'questioner',
      shardKey: null,
    })
    r = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_x')))[0]!
    expect(r.consumedByConsumerRunId).toBe('nr_d')
    expect(r.consumedByQuestionerRunId).toBe('nr_q')
  })
})

// ---------------------------------------------------------------------------
// B13 — shardKey filter on self-clarify mark.
// ---------------------------------------------------------------------------

describe('RFC-070 B13 — self-clarify mark respects shardKey scope', () => {
  test('shard A done does not stamp shard B rows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_sA', taskId, nodeId: 'designer', status: 'done', shardKey: 'A' },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_a',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_sA',
        askingShardKey: 'A',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_c',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('shard A Q'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
      },
      {
        id: 'r_b',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_sA',
        askingShardKey: 'B',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_c',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('shard B Q'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
      },
    ])
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_sA',
      taskId,
      nodeId: 'designer',
      shardKey: 'A',
    })
    const a = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_a')))[0]!
    const b = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_b')))[0]!
    expect(a.consumedByConsumerRunId).toBe('nr_sA')
    expect(b.consumedByConsumerRunId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// B14 — FK ON DELETE SET NULL clears stamp on node_run cascade-delete.
// ---------------------------------------------------------------------------

describe('RFC-070 B14 — FK ON DELETE SET NULL clears stamp without removing the Q&A row', () => {
  test('deleting the consumer node_run nulls only the consumed stamp; the Q&A row stays', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // The consumer (stamping) run is a SEPARATE node_run from the asking
    // run so the askingNodeRunId FK (ON DELETE CASCADE per RFC-058 schema)
    // doesn't take the Q&A row with it. RFC-070 only adds the consumed_by
    // FK with ON DELETE SET NULL — that's the contract under test.
    await db.insert(nodeRuns).values([
      { id: 'nr_asking', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_consumer', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_keep',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_asking',
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: 'nr_c',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('keep me'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
      consumedByConsumerRunId: 'nr_consumer',
    })
    // Delete only the consumer (stamping) node_run. askingNodeRunId points
    // at nr_asking which still exists, so the round survives — only the
    // consumed_by_consumer_run_id stamp goes to NULL via SET NULL FK.
    await db.delete(nodeRuns).where(eq(nodeRuns.id, 'nr_consumer'))
    const r = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_keep')))[0]!
    expect(r).toBeDefined()
    expect(r.consumedByConsumerRunId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// B11 — dual-write: legacy clarify_sessions / cross_clarify_sessions and the
// unified clarify_rounds get stamped in the same mark call.
// ---------------------------------------------------------------------------

describe('RFC-070 B11 — mark stamps unified + legacy mirror tables in one call', () => {
  test('cross row stamped on both clarify_rounds and cross_clarify_sessions', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d', taskId, nodeId: 'designer', status: 'done' },
      { id: 'nr_q', taskId, nodeId: 'questioner', status: 'done' },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human' },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_mirror',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('mirror Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await db.insert(crossClarifySessions).values({
      id: 'r_mirror',
      taskId,
      crossClarifyNodeId: 'cc1',
      crossClarifyNodeRunId: 'nr_cc',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: questionsJson('mirror Q'),
      answersJson: answersJson(),
      directive: 'continue',
      status: 'answered',
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_d',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    const cr = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_mirror')))[0]!
    const ccs = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, 'r_mirror'))
    )[0]!
    expect(cr.consumedByConsumerRunId).toBe('nr_d')
    expect(ccs.consumedByConsumerRunId).toBe('nr_d')
  })
})

// ---------------------------------------------------------------------------
// B12 — selectAnsweredRoundsForConsumer returns only un-consumed rows; no
// counter math leaked.
// ---------------------------------------------------------------------------

describe('RFC-070 B12 — selectAnsweredRoundsForConsumer applies IS NULL filter inline', () => {
  test('self consumer: returns only the round whose consumed_by_consumer_run_id is NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d', taskId, nodeId: 'd', status: 'done' },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r1',
        taskId,
        kind: 'self',
        askingNodeId: 'd',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_c',
        loopIter: 0,
        iteration: 0,
        questionsJson: questionsJson('consumed'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        consumedByConsumerRunId: 'nr_d',
      },
      {
        id: 'r2',
        taskId,
        kind: 'self',
        askingNodeId: 'd',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'c1',
        intermediaryNodeRunId: 'nr_c',
        loopIter: 0,
        iteration: 1,
        questionsJson: questionsJson('open'),
        answersJson: answersJson(),
        directive: 'continue',
        status: 'answered',
        consumedByConsumerRunId: null,
      },
    ])
    const rows = await selectAnsweredRoundsForConsumer({
      db,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'd',
      shardKey: null,
    })
    expect(rows.map((r) => r.id)).toEqual(['r2'])
  })
})

// ---------------------------------------------------------------------------
// B-extra — mark gate test: a no-output completion path doesn't stamp.
// The gating is in runner.ts (outputsPersistedCount > 0), but we verify the
// helper's "IS NULL" predicate independently: calling mark with no Q&A rows
// to match is a no-op.
// ---------------------------------------------------------------------------

describe('RFC-070 B-extra — mark helper is safe to call when no matching rows exist', () => {
  test('mark with no clarify rounds present does not error', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_only',
      taskId,
      nodeId: 'designer',
      status: 'done',
    })
    await markClarifyRoundsConsumedBy(db, {
      id: 'nr_only',
      taskId,
      nodeId: 'designer',
      shardKey: null,
    })
    const remaining = await db
      .select()
      .from(clarifyRounds)
      .where(and(eq(clarifyRounds.taskId, taskId), isNull(clarifyRounds.consumedByConsumerRunId)))
    expect(remaining.length).toBe(0)
  })
})
