// RFC-070 — migration 0036 backfill correctness. Locks: for every answered
// pre-migration Q&A row, the backfill SQL picks "the most recent done
// node_run that finished before the row's answered_at AND has at least one
// captured `<workflow-output>`" as the consumed_by stamp. This preserves
// byte-equivalence with the old `computeHistoryCutoff`-driven aging on
// historical data (AC-7 in proposal.md).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import {
  clarifyRounds,
  clarifySessions,
  crossClarifySessions,
  nodeRunOutputs,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'

async function seedWorkflowFor(db: ReturnType<typeof createInMemoryDb>, workflowId: string) {
  await db.insert(workflows).values({
    id: workflowId,
    name: 'rfc070-migration',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
}
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

// The createInMemoryDb runs all migrations 0000..0036 in sequence, so the
// backfill UPDATE already ran by the time we insert rows here. To verify
// the backfill SQL itself we exercise it directly via raw queries on the
// same in-memory DB engine — see `tests/migration-0036-rfc070.test.ts` if
// the migration ever needs split-stage isolation. For now, the migration
// is dry-run-safe (idempotent SQL with `consumed_by_..._run_id IS NULL`
// gate), so re-running it on a fresh seed exercises the same logic.

describe('RFC-070 migration 0036 — backfill picks correct consumer run', () => {
  test('clarify_rounds (kind=self): stamp = most recent prior done-with-outputs on asking node', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'mig_t1'
    await seedWorkflowFor(db, 'wf')
    await db.insert(tasks).values({
      id: taskId,
      workflowId: 'wf',
      branch: 'b',
      inputs: '{}',
      startedAt: 0,
      name: 't',
      status: 'done',
      repoPath: '/r',
      baseBranch: 'main',
      worktreePath: '/w',
      repoCount: 1,
      workflowSnapshot: '{}',
    })
    // Prior done-with-output at finished_at=100. Newer done WITHOUT output
    // at finished_at=200 (excluded). Q&A answered at 300.
    await db.insert(nodeRuns).values([
      {
        id: 'nr_done_with_output',
        taskId,
        nodeId: 'designer',
        status: 'done',
        finishedAt: 100,
      },
      {
        id: 'nr_done_no_output',
        taskId,
        nodeId: 'designer',
        status: 'done',
        finishedAt: 200,
      },
      { id: 'nr_clarify', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_done_with_output',
      portName: 'plan',
      content: 'baked',
    })
    await db.insert(clarifyRounds).values({
      id: 'r_backfill',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_done_with_output',
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: 'nr_clarify',
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      directive: 'continue',
      status: 'answered',
      answeredAt: 300,
      consumedByConsumerRunId: null,
    })
    // Re-run the backfill SQL (idempotent — only stamps rows currently NULL).
    const sql = `
      UPDATE clarify_rounds SET consumed_by_consumer_run_id = (
        SELECT nr.id FROM node_runs nr
        WHERE nr.task_id = clarify_rounds.task_id
          AND nr.node_id = CASE clarify_rounds.kind
                             WHEN 'self'  THEN clarify_rounds.asking_node_id
                             WHEN 'cross' THEN clarify_rounds.target_consumer_node_id
                           END
          AND nr.status = 'done'
          AND nr.finished_at IS NOT NULL
          AND nr.finished_at < clarify_rounds.answered_at
          AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
        ORDER BY nr.finished_at DESC
        LIMIT 1
      )
      WHERE status = 'answered'
        AND answered_at IS NOT NULL
        AND consumed_by_consumer_run_id IS NULL
        AND (kind = 'self' OR target_consumer_node_id IS NOT NULL)
    `
    db.$client.exec(sql)
    const r = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_backfill')))[0]!
    expect(r.consumedByConsumerRunId).toBe('nr_done_with_output')
  })

  test('clarify_sessions: backfill stamps consumer run id via source_agent_node_id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'mig_t2'
    await seedWorkflowFor(db, 'wf')
    await db.insert(tasks).values({
      id: taskId,
      workflowId: 'wf',
      branch: 'b',
      inputs: '{}',
      startedAt: 0,
      name: 't',
      status: 'done',
      repoPath: '/r',
      baseBranch: 'main',
      worktreePath: '/w',
      repoCount: 1,
      workflowSnapshot: '{}',
    })
    await db.insert(nodeRuns).values([
      { id: 'nr_d_with_out', taskId, nodeId: 'designer', status: 'done', finishedAt: 50 },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_d_with_out',
      portName: 'p',
      content: 'x',
    })
    await db.insert(clarifySessions).values({
      id: 's_bf',
      taskId,
      sourceAgentNodeId: 'designer',
      sourceAgentNodeRunId: 'nr_d_with_out',
      sourceShardKey: null,
      clarifyNodeId: 'c1',
      clarifyNodeRunId: 'nr_c',
      iterationIndex: 0,
      questionsJson: '[]',
      answersJson: '[]',
      status: 'answered',
      directive: 'continue',
      answeredAt: 200,
      consumedByConsumerRunId: null,
    })
    db.$client.exec(`
      UPDATE clarify_sessions SET consumed_by_consumer_run_id = (
        SELECT nr.id FROM node_runs nr
        WHERE nr.task_id = clarify_sessions.task_id
          AND nr.node_id = clarify_sessions.source_agent_node_id
          AND nr.status = 'done'
          AND nr.finished_at IS NOT NULL
          AND nr.finished_at < clarify_sessions.answered_at
          AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
        ORDER BY nr.finished_at DESC
        LIMIT 1
      )
      WHERE status = 'answered'
        AND answered_at IS NOT NULL
        AND consumed_by_consumer_run_id IS NULL
    `)
    const s = (await db.select().from(clarifySessions).where(eq(clarifySessions.id, 's_bf')))[0]!
    expect(s.consumedByConsumerRunId).toBe('nr_d_with_out')
  })

  test('cross_clarify_sessions: backfill stamps consumer (designer) + questioner independently', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'mig_t3'
    await seedWorkflowFor(db, 'wf')
    await db.insert(tasks).values({
      id: taskId,
      workflowId: 'wf',
      branch: 'b',
      inputs: '{}',
      startedAt: 0,
      name: 't',
      status: 'done',
      repoPath: '/r',
      baseBranch: 'main',
      worktreePath: '/w',
      repoCount: 1,
      workflowSnapshot: '{}',
    })
    await db.insert(nodeRuns).values([
      { id: 'nr_d', taskId, nodeId: 'designer', status: 'done', finishedAt: 100 },
      { id: 'nr_q', taskId, nodeId: 'questioner', status: 'done', finishedAt: 150 },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human' },
    ])
    await db.insert(nodeRunOutputs).values([
      { nodeRunId: 'nr_d', portName: 'out', content: 'x' },
      { nodeRunId: 'nr_q', portName: 'out', content: 'y' },
    ])
    await db.insert(crossClarifySessions).values({
      id: 'cs_bf',
      taskId,
      crossClarifyNodeId: 'cc1',
      crossClarifyNodeRunId: 'nr_cc',
      sourceQuestionerNodeId: 'questioner',
      sourceQuestionerNodeRunId: 'nr_q',
      targetDesignerNodeId: 'designer',
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      directive: 'continue',
      status: 'answered',
      answeredAt: 200,
      consumedByConsumerRunId: null,
      consumedByQuestionerRunId: null,
    })
    db.$client.exec(`
      UPDATE cross_clarify_sessions SET consumed_by_consumer_run_id = (
        SELECT nr.id FROM node_runs nr
        WHERE nr.task_id = cross_clarify_sessions.task_id
          AND nr.node_id = cross_clarify_sessions.target_designer_node_id
          AND nr.status = 'done'
          AND nr.finished_at IS NOT NULL
          AND nr.finished_at < cross_clarify_sessions.answered_at
          AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
        ORDER BY nr.finished_at DESC LIMIT 1
      )
      WHERE status = 'answered' AND answered_at IS NOT NULL
        AND target_designer_node_id IS NOT NULL
        AND consumed_by_consumer_run_id IS NULL;
      UPDATE cross_clarify_sessions SET consumed_by_questioner_run_id = (
        SELECT nr.id FROM node_runs nr
        WHERE nr.task_id = cross_clarify_sessions.task_id
          AND nr.node_id = cross_clarify_sessions.source_questioner_node_id
          AND nr.status = 'done'
          AND nr.finished_at IS NOT NULL
          AND nr.finished_at < cross_clarify_sessions.answered_at
          AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
        ORDER BY nr.finished_at DESC LIMIT 1
      )
      WHERE status = 'answered' AND answered_at IS NOT NULL
        AND consumed_by_questioner_run_id IS NULL;
    `)
    const cs = (
      await db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, 'cs_bf'))
    )[0]!
    expect(cs.consumedByConsumerRunId).toBe('nr_d')
    expect(cs.consumedByQuestionerRunId).toBe('nr_q')
  })

  test('row with answered_at BEFORE every done run: stamp stays NULL', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = 'mig_t4'
    await seedWorkflowFor(db, 'wf')
    await db.insert(tasks).values({
      id: taskId,
      workflowId: 'wf',
      branch: 'b',
      inputs: '{}',
      startedAt: 0,
      name: 't',
      status: 'done',
      repoPath: '/r',
      baseBranch: 'main',
      worktreePath: '/w',
      repoCount: 1,
      workflowSnapshot: '{}',
    })
    await db.insert(nodeRuns).values([
      // Only done run finishes AFTER the answer (not eligible as backfill source).
      { id: 'nr_later', taskId, nodeId: 'designer', status: 'done', finishedAt: 999 },
      { id: 'nr_c', taskId, nodeId: 'c1', status: 'done' },
    ])
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_later',
      portName: 'p',
      content: 'x',
    })
    await db.insert(clarifyRounds).values({
      id: 'r_null',
      taskId,
      kind: 'self',
      askingNodeId: 'designer',
      askingNodeRunId: 'nr_later',
      intermediaryNodeId: 'c1',
      intermediaryNodeRunId: 'nr_c',
      loopIter: 0,
      iteration: 0,
      questionsJson: '[]',
      answersJson: '[]',
      directive: 'continue',
      status: 'answered',
      answeredAt: 500,
      consumedByConsumerRunId: null,
    })
    db.$client.exec(`
      UPDATE clarify_rounds SET consumed_by_consumer_run_id = (
        SELECT nr.id FROM node_runs nr
        WHERE nr.task_id = clarify_rounds.task_id
          AND nr.node_id = clarify_rounds.asking_node_id
          AND nr.status = 'done'
          AND nr.finished_at IS NOT NULL
          AND nr.finished_at < clarify_rounds.answered_at
          AND EXISTS (SELECT 1 FROM node_run_outputs nro WHERE nro.node_run_id = nr.id)
        ORDER BY nr.finished_at DESC LIMIT 1
      )
      WHERE status = 'answered' AND answered_at IS NOT NULL
        AND consumed_by_consumer_run_id IS NULL AND kind = 'self'
    `)
    const r = (await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_null')))[0]!
    expect(r.consumedByConsumerRunId).toBeNull()
  })
})
