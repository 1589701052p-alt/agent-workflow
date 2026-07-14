// RFC-W004 T5 - migration 0090: clarify_rounds gains kind='to-agent' +
// answerer tracking columns (design §2.6).
//
// LOCKS:
//   M1 the 12-step table rebuild ships every statement behind a
//      `--> statement-breakpoint` (0052/0053 silent-truncation incident).
//   M2 `kind` CHECK widened to admit 'to-agent' (insert succeeds).
//   M3 self / cross rows land with the two new answerer columns NULL
//      (zero backfill - existing rows have no answerer).
//   M4 a to-agent row round-trips with answerer_node_id +
//      answerer_node_run_id set.
//   M5 composite CHECK widening: to-agent is exempt from BOTH the
//      self-can't-be-abandoned and cross-can't-be-canceled restrictions
//      (to-agent may reach abandoned on A-fail upgrade AND canceled on
//      task-cancel). self/cross restrictions still hold (regression guard).
//   M6 the new idx_clarify_rounds_answerer index exists (answerer lookup).
//
// Idempotency: createInMemoryDb replays the full journal including 0090
// against the prior-shape clarify_rounds (built by 0031); a clean apply with
// self/cross data preserved (M3) is the idempotency proof.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { createInMemoryDb } from '../src/db/client'
import { clarifyRounds, nodeRuns, tasks, workflows } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const SQL_PATH = resolve(MIGRATIONS, '0090_rfc_w004_clarify_to_agent.sql')

const QUESTIONS_JSON = JSON.stringify([
  {
    id: 'q1',
    title: 'Q',
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  },
])

async function seedTask(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w004-migrate',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'w004-migrate',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/tmp/w004/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: 1_700_000_000_000,
  })
  return taskId
}

// Drizzle's insert builder is a thenable, not a real Promise, so
// `expect(...).rejects` won't unwrap it (bun:test requires a Promise). Await
// the thenable inside try/catch to assert the underlying SQLite CHECK fires.
async function expectCheckRejects(insert: PromiseLike<unknown>) {
  let threw = false
  try {
    await insert
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

describe('RFC-W004 T5 - migration 0090', () => {
  test('M1 12-step rebuild ships every statement behind a breakpoint (no silent truncation)', () => {
    const src = readFileSync(SQL_PATH, 'utf8')
    const statements = src.split('--> statement-breakpoint')
    // PRAGMA off, CREATE __new, INSERT..SELECT, DROP, RENAME, 6 indexes, PRAGMA on.
    expect(statements.length).toBe(12)
    // The answerer index must be among the recreated indexes.
    expect(src.includes('idx_clarify_rounds_answerer')).toBe(true)
    // Composite CHECK must exempt to-agent from both restrictions.
    expect(src.includes("`kind` = 'to-agent'")).toBe(true)
  })

  test('M2 kind CHECK admits to-agent (insert succeeds)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_b', taskId, nodeId: 'B', status: 'awaiting_human', retryIndex: 0, iteration: 0 },
      {
        id: 'nr_ca',
        taskId,
        nodeId: 'toagent',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_toagent',
      taskId,
      kind: 'to-agent',
      askingNodeId: 'B',
      askingNodeRunId: 'nr_b',
      intermediaryNodeId: 'toagent',
      intermediaryNodeRunId: 'nr_ca',
      iteration: 0,
      questionsJson: QUESTIONS_JSON,
      status: 'awaiting_human',
    })
    const row = await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_toagent')).get()
    expect(row?.kind).toBe('to-agent')
  })

  test('M3 self / cross rows land with answerer columns NULL (zero backfill)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_d', taskId, nodeId: 'designer', status: 'done', retryIndex: 0, iteration: 0 },
      {
        id: 'nr_c',
        taskId,
        nodeId: 'clarify1',
        status: 'awaiting_human',
        retryIndex: 0,
        iteration: 0,
      },
      { id: 'nr_q', taskId, nodeId: 'questioner', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'awaiting_human', retryIndex: 0, iteration: 0 },
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
        questionsJson: QUESTIONS_JSON,
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
        questionsJson: QUESTIONS_JSON,
        status: 'awaiting_human',
      },
    ])
    const [selfRow, crossRow] = await Promise.all([
      db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_self')).get(),
      db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_cross')).get(),
    ])
    expect(selfRow?.answererNodeId).toBeNull()
    expect(selfRow?.answererNodeRunId).toBeNull()
    expect(crossRow?.answererNodeId).toBeNull()
    expect(crossRow?.answererNodeRunId).toBeNull()
  })

  test('M4 to-agent row round-trips answerer_node_id + answerer_node_run_id', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_b', taskId, nodeId: 'B', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_ca', taskId, nodeId: 'toagent', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_a', taskId, nodeId: 'A', status: 'done', retryIndex: 0, iteration: 0 },
    ])
    await db.insert(clarifyRounds).values({
      id: 'r_ans',
      taskId,
      kind: 'to-agent',
      askingNodeId: 'B',
      askingNodeRunId: 'nr_b',
      intermediaryNodeId: 'toagent',
      intermediaryNodeRunId: 'nr_ca',
      answererNodeId: 'A',
      answererNodeRunId: 'nr_a',
      iteration: 0,
      questionsJson: QUESTIONS_JSON,
      answersJson: JSON.stringify([{ questionId: 'q1', markdown: 'A says: do X' }]),
      status: 'answered',
    })
    const row = await db.select().from(clarifyRounds).where(eq(clarifyRounds.id, 'r_ans')).get()
    expect(row?.answererNodeId).toBe('A')
    expect(row?.answererNodeRunId).toBe('nr_a')
    expect(row?.status).toBe('answered')
  })

  test('M5 composite CHECK: to-agent may be abandoned AND canceled; self/cross restrictions hold', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeRuns).values([
      { id: 'nr_b', taskId, nodeId: 'B', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_ca', taskId, nodeId: 'toagent', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_d', taskId, nodeId: 'designer', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_c', taskId, nodeId: 'clarify1', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_q', taskId, nodeId: 'questioner', status: 'done', retryIndex: 0, iteration: 0 },
      { id: 'nr_cc', taskId, nodeId: 'cc1', status: 'done', retryIndex: 0, iteration: 0 },
    ])

    const baseToAgent = {
      taskId,
      kind: 'to-agent' as const,
      askingNodeId: 'B',
      askingNodeRunId: 'nr_b',
      intermediaryNodeId: 'toagent',
      intermediaryNodeRunId: 'nr_ca',
      iteration: 0,
      questionsJson: QUESTIONS_JSON,
    }

    // to-agent admits abandoned (A-fail -> CR-1 upgrade, like cross) ...
    await db.insert(clarifyRounds).values({ ...baseToAgent, id: 'r_ta_ab', status: 'abandoned' })
    // ... and canceled (task-cancel path, like self).
    await db.insert(clarifyRounds).values({ ...baseToAgent, id: 'r_ta_cx', status: 'canceled' })

    // self must STILL reject abandoned (regression guard).
    await expectCheckRejects(
      db.insert(clarifyRounds).values({
        id: 'r_self_ab',
        taskId,
        kind: 'self',
        askingNodeId: 'designer',
        askingNodeRunId: 'nr_d',
        intermediaryNodeId: 'clarify1',
        intermediaryNodeRunId: 'nr_c',
        iteration: 0,
        questionsJson: QUESTIONS_JSON,
        status: 'abandoned',
      }),
    )

    // cross must STILL reject canceled (regression guard).
    await expectCheckRejects(
      db.insert(clarifyRounds).values({
        id: 'r_cross_cx',
        taskId,
        kind: 'cross',
        askingNodeId: 'questioner',
        askingNodeRunId: 'nr_q',
        intermediaryNodeId: 'cc1',
        intermediaryNodeRunId: 'nr_cc',
        targetConsumerNodeId: 'designer',
        iteration: 0,
        questionsJson: QUESTIONS_JSON,
        status: 'canceled',
      }),
    )
  })

  test('M6 idx_clarify_rounds_answerer index exists', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const rows = db.values(
      sql.raw(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'clarify_rounds' ORDER BY name",
      ),
    ) as unknown[][]
    const names = rows.map((r) => r[0] as string)
    expect(names).toContain('idx_clarify_rounds_answerer')
    // The pre-existing indexes were recreated too (no regression).
    expect(names).toContain('idx_clarify_rounds_kind_status')
    expect(names).toContain('idx_clarify_rounds_target_consumer')
  })
})
