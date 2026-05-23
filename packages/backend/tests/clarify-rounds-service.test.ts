// RFC-058 T12 — unit tests for the unified clarify_rounds service helpers.
// Exercises:
//   - computeHistoryCutoff for kind='self' + kind='cross' iterationField
//   - selectAnsweredRoundsForConsumer per consumerKind (self / cross-designer /
//     cross-questioner), including shardKey filter + loopIter isolation
//   - buildPromptContext multi-round / aging cutoff / inline mode / wrapper-
//     loop loop_iter isolation (RFC-056 缺口 2 structurally fixed)
//   - listClarifyRounds filter dispatch
//
// Notes for T12 stage:
//   - Tests seed clarify_rounds DIRECTLY (no legacy clarify_sessions write path)
//     because the new service module operates on the unified table. Once T17
//     drops the legacy tables + migrates all writers to clarify_rounds, the
//     PR-A baseline tests will exercise these helpers indirectly.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import {
  buildPromptContext,
  computeHistoryCutoff,
  listClarifyRounds,
  selectAnsweredRoundsForConsumer,
} from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<{ taskId: string; definition: WorkflowDefinition }> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode,
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' } as WorkflowNode,
      { id: 'clarify1', kind: 'clarify', title: 'Clarify' } as WorkflowNode,
      { id: 'cc1', kind: 'clarify-cross-agent', title: 'CC1' } as WorkflowNode,
    ],
    edges: [],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rounds-test',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rounds-test',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-rounds/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return { taskId, definition }
}

function sampleQuestionsJson(title: string): string {
  return JSON.stringify([
    {
      id: 'q1',
      title,
      kind: 'single',
      recommended: false,
      options: [
        { label: 'A', description: '', recommended: false, recommendationReason: '' },
        { label: 'B', description: '', recommended: false, recommendationReason: '' },
      ],
    },
  ])
}

function sampleAnswersJson(): string {
  return JSON.stringify([
    {
      questionId: 'q1',
      selectedOptionIndices: [0],
      selectedOptionLabels: ['A'],
      customText: '',
    },
  ])
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-058 T12 — computeHistoryCutoff (GENERAL aging rule)', () => {
  test('returns undefined when no prior done run exists', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      iterationField: 'clarifyIteration',
      shardKey: null,
    })
    expect(cutoff).toBeUndefined()
  })

  test('returns prior done run clarifyIteration when outputs row exists', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    // Prior done run with outputs — this is the cutoff source
    await db.insert(nodeRuns).values({
      id: 'nr_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 2,
      crossClarifyIteration: 0,
      startedAt: Date.now() - 1000,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_prior',
      portName: 'plan',
      content: 'output content',
    })
    // Current node_run at clarifyIteration 3 (the about-to-run)
    await db.insert(nodeRuns).values({
      id: 'nr_current',
      taskId,
      nodeId: 'designer',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 3,
    })
    const current = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'nr_current')))[0]!
    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      iterationField: 'clarifyIteration',
      currentRunRow: current,
      shardKey: null,
    })
    expect(cutoff).toBe(2)
  })

  test('returns undefined when prior done run has no outputs row', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_prior_no_outputs',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 2,
      startedAt: Date.now() - 1000,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_current',
      taskId,
      nodeId: 'designer',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 3,
    })
    const current = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'nr_current')))[0]!
    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      iterationField: 'clarifyIteration',
      currentRunRow: current,
      shardKey: null,
    })
    expect(cutoff).toBeUndefined()
  })

  test('iterationField=crossClarifyIteration returns cci of prior cross-clarify done run', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_cross_prior',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      crossClarifyIteration: 1,
      startedAt: Date.now() - 1000,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_cross_prior',
      portName: 'plan',
      content: 'designer output',
    })
    await db.insert(nodeRuns).values({
      id: 'nr_cross_current',
      taskId,
      nodeId: 'designer',
      status: 'pending',
      retryIndex: 1,
      iteration: 0,
      crossClarifyIteration: 2,
    })
    const current = (
      await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'nr_cross_current'))
    )[0]!
    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      iterationField: 'crossClarifyIteration',
      currentRunRow: current,
      shardKey: null,
    })
    expect(cutoff).toBe(1)
  })

  test('child shard run is excluded from cutoff (parent_node_run_id != null)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_parent',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      parentNodeRunId: null,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_child_shard',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 5,
      parentNodeRunId: 'nr_parent',
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_child_shard',
      portName: 'plan',
      content: 'shard output',
    })
    // The child shard's output is real but its row has parent_node_run_id;
    // computeHistoryCutoff excludes it from the cutoff scan.
    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      iterationField: 'clarifyIteration',
      shardKey: null,
    })
    expect(cutoff).toBeUndefined()
  })
})

describe('RFC-058 T12 — selectAnsweredRoundsForConsumer (read path)', () => {
  test('self: pulls kind=self rows for the asking agent + shardKey null', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_designer',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_clarify',
      taskId,
      nodeId: 'clarify1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(clarifyRounds).values([
      {
        id: 'r_self_0',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_designer',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_clarify',
        iteration: 0,
        questionsJson: sampleQuestionsJson('Self Q'),
        answersJson: sampleAnswersJson(),
        status: 'answered',
        directive: 'continue',
      },
    ])
    const rows = await selectAnsweredRoundsForConsumer({
      db,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      shardKey: null,
    })
    expect(rows.length).toBe(1)
    expect(rows[0]?.iteration).toBe(0)
  })

  test('self: rows from a different shard are filtered out', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_designer',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_clarify',
      taskId,
      nodeId: 'clarify1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(clarifyRounds).values({
      id: 'r_self_shard_A',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_designer',
      askingShardKey: 'shard-A',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_clarify',
      iteration: 0,
      questionsJson: sampleQuestionsJson('Shard A Q'),
      answersJson: sampleAnswersJson(),
      status: 'answered',
      directive: 'continue',
    })
    // shardKey=null consumer does NOT see shard-A rows
    const rows = await selectAnsweredRoundsForConsumer({
      db,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      shardKey: null,
    })
    expect(rows.length).toBe(0)
  })

  test('cross-questioner: loopIter isolation (RFC-058 缺口 2 structural fix)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_cc',
      taskId,
      nodeId: 'cc1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    // Iter 1 round answered
    await db.insert(clarifyRounds).values({
      id: 'r_iter1',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 1,
      iteration: 0,
      questionsJson: sampleQuestionsJson('iter-1 Q'),
      answersJson: sampleAnswersJson(),
      directive: 'continue',
      status: 'answered',
    })
    // Iter 2 questioner asks for its Q&A: loopIter filter must drop iter-1
    const rows = await selectAnsweredRoundsForConsumer({
      db,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      loopIter: 2,
    })
    expect(rows.length).toBe(0)
    // Iter 1 questioner asking for iter-1: sees the row
    const rowsIter1 = await selectAnsweredRoundsForConsumer({
      db,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      loopIter: 1,
    })
    expect(rowsIter1.length).toBe(1)
  })

  test('cross-designer: only directive=continue rows; per-intermediary latest', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values({
      id: 'nr_q',
      taskId,
      nodeId: 'questioner',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    await db.insert(nodeRuns).values({
      id: 'nr_cc',
      taskId,
      nodeId: 'cc1',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
    })
    // Iteration 0 = continue, iteration 1 = stop. cross-designer should NOT
    // include the stop row (no fresh External Feedback to surface) and only
    // get the iteration-1 row IF directive='continue'.
    await db.insert(clarifyRounds).values([
      {
        id: 'r_cd_iter0_continue',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        iteration: 0,
        questionsJson: sampleQuestionsJson('iter-0 Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
      {
        id: 'r_cd_iter1_stop',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        loopIter: 0,
        iteration: 1,
        questionsJson: sampleQuestionsJson('iter-1 Q'),
        answersJson: sampleAnswersJson(),
        directive: 'stop',
        status: 'answered',
      },
    ])
    const rows = await selectAnsweredRoundsForConsumer({
      db,
      taskId,
      consumerKind: 'cross-designer',
      consumerNodeId: 'designer',
      loopIter: 0,
    })
    // The stop row is excluded; iteration 0 (continue) is surfaced
    expect(rows.length).toBe(1)
    expect(rows[0]?.iteration).toBe(0)
  })
})

describe('RFC-058 T12 — buildPromptContext composes round blocks + applies aging', () => {
  test('returns undefined when targetIteration <= 0', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 0,
      shardKey: null,
    })
    expect(ctx).toBeUndefined()
  })

  test('builds multi-round questions/answers blocks chronologically', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_round0',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('Round 0 question?'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
      {
        id: 'r_round1',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 1,
        questionsJson: sampleQuestionsJson('Round 1 question?'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
    ])
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
    })
    expect(ctx).toBeDefined()
    expect(ctx?.questionsBlock).toContain('### Round 1')
    expect(ctx?.questionsBlock).toContain('### Round 2')
    expect(ctx?.questionsBlock).toContain('Round 0 question?')
    expect(ctx?.questionsBlock).toContain('Round 1 question?')
    expect(ctx?.iteration).toBe('2')
    expect(ctx?.directive).toBe('continue')
  })

  test('historyCutoff prunes rows with iteration < cutoff (GENERAL aging)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_pre_cutoff',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('pre-cutoff Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
      {
        id: 'r_post_cutoff',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 1,
        questionsJson: sampleQuestionsJson('post-cutoff Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
    ])
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      historyCutoff: 1,
    })
    expect(ctx?.questionsBlock).not.toContain('pre-cutoff Q')
    expect(ctx?.questionsBlock).toContain('post-cutoff Q')
  })

  test('cross-questioner aging fix (RFC-058 缺口 1): cutoff filters questioner side too', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await db.insert(nodeRuns).values([
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
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    // Questioner already produced an output at cci=1 — pre-cutoff round is
    // baked into that output; cci=2 cascade rerun must not see it.
    await db.insert(clarifyRounds).values({
      id: 'r_q_iter0',
      taskId,
      kind: 'cross',
      askingNodeId: 'questioner',
      askingNodeRunId: 'nr_q',
      intermediaryNodeId: 'cc1',
      intermediaryNodeRunId: 'nr_cc',
      targetConsumerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: sampleQuestionsJson('iter-0 questioner Q'),
      answersJson: sampleAnswersJson(),
      directive: 'continue',
      status: 'answered',
    })
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'cross-questioner',
      consumerNodeId: 'questioner',
      targetIteration: 2,
      historyCutoff: 1, // ← RFC-058: cross-questioner now respects this
      loopIter: 0,
    })
    // The iter-0 row is pre-cutoff → pruned. No further rows → undefined.
    expect(ctx).toBeUndefined()
  })

  test('inline mode collapses to last round + mode=inline tag', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_inline_0',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('older inline Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
      {
        id: 'r_inline_1',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 1,
        questionsJson: sampleQuestionsJson('newest inline Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
    ])
    const ctx = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 2,
      shardKey: null,
      sessionMode: 'inline',
    })
    expect(ctx?.mode).toBe('inline')
    expect(ctx?.currentRoundOnly).toBe(true)
    expect(ctx?.questionsBlock).toContain('newest inline Q')
    expect(ctx?.questionsBlock).not.toContain('older inline Q')
  })

  test('applyLatestDirective=false suppresses STOP CLARIFYING trailer', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId, definition } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_stop_0',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_d',
      intermediaryNodeId: 'clarify1',
      intermediaryNodeRunId: 'nr_c',
      iteration: 0,
      questionsJson: sampleQuestionsJson('stop Q'),
      answersJson: sampleAnswersJson(),
      directive: 'stop',
      status: 'answered',
    })
    const withDir = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      applyLatestDirective: true,
    })
    expect(withDir?.directive).toBe('stop')
    expect(withDir?.answersBlock).toContain('STOP CLARIFYING')

    const noDir = await buildPromptContext({
      db,
      definition,
      taskId,
      consumerKind: 'self',
      consumerNodeId: 'designer',
      targetIteration: 1,
      shardKey: null,
      applyLatestDirective: false,
    })
    expect(noDir?.directive).toBe('continue')
    expect(noDir?.answersBlock).not.toContain('STOP CLARIFYING')
  })
})

describe('RFC-058 T12 — listClarifyRounds filter dispatch', () => {
  test('kind=all returns both self + cross; kind filter narrows', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
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
    await db.insert(clarifyRounds).values([
      {
        id: 'r_self',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('self Q'),
        status: 'awaiting_human',
      },
      {
        id: 'r_cross',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        iteration: 0,
        questionsJson: sampleQuestionsJson('cross Q'),
        status: 'awaiting_human',
      },
    ])
    const all = await listClarifyRounds(db, { taskId, kind: 'all', status: 'awaiting_human' })
    expect(all.length).toBe(2)
    const selfOnly = await listClarifyRounds(db, { taskId, kind: 'self', status: 'awaiting_human' })
    expect(selfOnly.length).toBe(1)
    expect(selfOnly[0]?.kind).toBe('self')
    const crossOnly = await listClarifyRounds(db, {
      taskId,
      kind: 'cross',
      status: 'awaiting_human',
    })
    expect(crossOnly.length).toBe(1)
    expect(crossOnly[0]?.kind).toBe('cross')
  })

  test('limit caps the result set; default status=awaiting_human filters answered', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const { taskId } = await seedTask(db)
    await db.insert(nodeRuns).values([
      {
        id: 'nr_d',
        taskId,
        nodeId: 'designer',
        status: 'done',
        retryIndex: 0,
        iteration: 0,
      },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values([
      {
        id: 'r_a_open',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: sampleQuestionsJson('open Q'),
        status: 'awaiting_human',
      },
      {
        id: 'r_b_done',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 1,
        questionsJson: sampleQuestionsJson('done Q'),
        answersJson: sampleAnswersJson(),
        directive: 'continue',
        status: 'answered',
      },
    ])
    // Default status filter only surfaces awaiting_human
    const open = await listClarifyRounds(db, { taskId })
    expect(open.length).toBe(1)
    expect(open[0]?.status).toBe('awaiting_human')
    // Explicit limit cap
    const limited = await listClarifyRounds(db, { taskId, status: 'all', limit: 1 })
    expect(limited.length).toBe(1)
  })
})
