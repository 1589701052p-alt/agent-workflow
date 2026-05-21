// RFC-053 PR-E — stuck-task detector (S1/S2/S3/S4).
//
// Each rule has at least one "stuck" case + one "not stuck" case (the
// negative is the freshness gate or the rule's evidence-present clause).
// Tests construct a single task with the relevant supporting rows, then
// call `runStuckTaskDetector` and assert on `openAlerts` filtered to the
// rule under test.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

import type { DbClient } from '../src/db/client'
import { createInMemoryDb } from '../src/db/client'
import {
  clarifySessions,
  docVersions,
  lifecycleAlerts,
  nodeRunEvents,
  nodeRuns,
  tasks,
  workflows,
} from '../src/db/schema'
import { runStuckTaskDetector } from '../src/services/stuckTaskDetector'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const MIN_MS = 60_000
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0) // fixed clock for reproducibility

type TaskStatus = 'pending' | 'running' | 'awaiting_review' | 'awaiting_human'

interface Harness {
  db: DbClient
  taskId: string
  cleanup: () => void
}

async function buildHarness(
  status: TaskStatus,
  startedAt: number,
  nodes: WorkflowNode[] = [],
): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc053-pre-stuck-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const def: WorkflowDefinition = { $schema_version: 2, inputs: [], nodes, edges: [] }
  const workflowId = ulid()
  await db.insert(workflows).values({ id: workflowId, name: 'w', definition: JSON.stringify(def) })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: tmp,
    worktreePath: tmp,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status,
    inputs: '{}',
    startedAt,
  })
  return { db, taskId, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function insertRun(
  db: DbClient,
  taskId: string,
  opts: {
    nodeId: string
    status:
      | 'pending'
      | 'running'
      | 'awaiting_review'
      | 'awaiting_human'
      | 'done'
      | 'failed'
      | 'canceled'
      | 'interrupted'
      | 'skipped'
      | 'exhausted'
    finishedAt?: number | null
  },
): Promise<string> {
  const id = ulid()
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId: opts.nodeId,
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    clarifyIteration: 0,
    status: opts.status,
    startedAt: T0 - MIN_MS,
    finishedAt: opts.finishedAt ?? null,
  })
  return id
}

async function insertEvent(db: DbClient, nodeRunId: string, ts: number): Promise<void> {
  await db.insert(nodeRunEvents).values({
    nodeRunId,
    ts,
    kind: 'text',
    payload: '{}',
  })
}

describe('RFC-053 PR-E — S4 (pending too long)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: pending > 5 min → S4 alert', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const s4 = r.openAlerts.filter((a) => a.rule === 'S4')
    expect(s4).toHaveLength(1)
    expect(s4[0]!.detail).toMatchObject({
      rule: 'S4',
      pendingForMs: 10 * MIN_MS,
    })
  })

  test('not stuck: pending < 5 min → no S4 alert', async () => {
    h = await buildHarness('pending', T0 - 2 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S4')).toHaveLength(0)
  })
})

describe('RFC-053 PR-E — S1 (awaiting_review without pending dv)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: awaiting_review > 30 min + no pending dv → S1 alert', async () => {
    h = await buildHarness('awaiting_review', T0 - 60 * MIN_MS)
    // No pending doc_version, no events.
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S1')).toHaveLength(1)
  })

  test('not stuck: has a pending dv → no S1 alert', async () => {
    h = await buildHarness('awaiting_review', T0 - 60 * MIN_MS)
    const run = await insertRun(h.db, h.taskId, { nodeId: 'rev', status: 'awaiting_review' })
    await h.db.insert(docVersions).values({
      id: ulid(),
      taskId: h.taskId,
      reviewNodeId: 'rev',
      reviewNodeRunId: run,
      sourceNodeId: 'doc',
      sourcePortName: 'docpath',
      versionIndex: 1,
      reviewIteration: 0,
      bodyPath: 'dv/v1.md',
      decision: 'pending',
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S1')).toHaveLength(0)
  })

  test('freshness gate: recent activity < 30 min → no S1 alert', async () => {
    h = await buildHarness('awaiting_review', T0 - 60 * MIN_MS)
    const run = await insertRun(h.db, h.taskId, { nodeId: 'rev', status: 'awaiting_review' })
    await insertEvent(h.db, run, T0 - 5 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S1')).toHaveLength(0)
  })
})

describe('RFC-053 PR-E — S2 (awaiting_human without open clarify_session)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: awaiting_human > 30 min + no open session → S2 alert', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(1)
  })

  test('not stuck: has an open clarify_session → no S2 alert', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const run = await insertRun(h.db, h.taskId, { nodeId: 'clr', status: 'awaiting_human' })
    await h.db.insert(clarifySessions).values({
      id: ulid(),
      taskId: h.taskId,
      sourceAgentNodeId: 'src',
      sourceAgentNodeRunId: ulid(),
      sourceShardKey: null,
      clarifyNodeId: 'clr',
      clarifyNodeRunId: run,
      iterationIndex: 0,
      questionsJson: '[]',
      answersJson: null,
      status: 'awaiting_human',
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(0)
  })

  test('closed sessions do NOT save S2 from firing', async () => {
    h = await buildHarness('awaiting_human', T0 - 45 * MIN_MS)
    const run = await insertRun(h.db, h.taskId, { nodeId: 'clr', status: 'awaiting_human' })
    await h.db.insert(clarifySessions).values({
      id: ulid(),
      taskId: h.taskId,
      sourceAgentNodeId: 'src',
      sourceAgentNodeRunId: ulid(),
      sourceShardKey: null,
      clarifyNodeId: 'clr',
      clarifyNodeRunId: run,
      iterationIndex: 0,
      questionsJson: '[]',
      answersJson: '[]',
      status: 'answered', // ← closed
      answeredAt: T0 - 40 * MIN_MS,
    })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S2')).toHaveLength(1)
  })
})

describe('RFC-053 PR-E — S3 (running but all node_runs terminal)', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('stuck: running > 30 min + all runs done → S3 alert', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'done', finishedAt: T0 - 35 * MIN_MS })
    await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'done', finishedAt: T0 - 32 * MIN_MS })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const s3 = r.openAlerts.filter((a) => a.rule === 'S3')
    expect(s3).toHaveLength(1)
    expect(s3[0]!.detail).toMatchObject({ totalRuns: 2, terminalRuns: 2 })
  })

  test('not stuck: at least one running node_run → no S3 alert', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'done', finishedAt: T0 - 35 * MIN_MS })
    await insertRun(h.db, h.taskId, { nodeId: 'b', status: 'running' })
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S3')).toHaveLength(0)
  })

  test('vacuous: running with empty node_runs → no S3 (different layer)', async () => {
    h = await buildHarness('running', T0 - 60 * MIN_MS)
    // Deliberately no node_runs → bootstrap state; S3 conservatively skips.
    const r = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r.openAlerts.filter((a) => a.rule === 'S3')).toHaveLength(0)
  })
})

describe('RFC-053 PR-E — reconcile + WS onAlert', () => {
  let h: Harness
  afterEach(() => h?.cleanup())

  test('second scan with no fix → no second insert, same open row', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    const r1 = await runStuckTaskDetector({ db: h.db, now: () => T0 })
    expect(r1.newAlerts).toBe(1)
    const r2 = await runStuckTaskDetector({ db: h.db, now: () => T0 + MIN_MS })
    expect(r2.newAlerts).toBe(0)
    const rows = await h.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, h.taskId))
    expect(rows).toHaveLength(1)
  })

  test('resolution: when the condition lifts the open row gets resolved_at', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    await runStuckTaskDetector({ db: h.db, now: () => T0 })
    // Promote task out of pending.
    await h.db.update(tasks).set({ status: 'running' }).where(eq(tasks.id, h.taskId))
    // Give it an active run so S3 doesn't immediately fire.
    await insertRun(h.db, h.taskId, { nodeId: 'a', status: 'running' })
    const r2 = await runStuckTaskDetector({ db: h.db, now: () => T0 + MIN_MS })
    expect(r2.resolvedAlerts).toBe(1)
    expect(r2.openAlerts.filter((a) => a.rule === 'S4')).toHaveLength(0)
  })

  test('onAlert(new) fires exactly once per new alert', async () => {
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    const calls: Array<{ rule: string; transition: 'new' | 'promoted' }> = []
    await runStuckTaskDetector({
      db: h.db,
      now: () => T0,
      onAlert: (row, transition) => calls.push({ rule: row.rule, transition }),
    })
    expect(calls).toEqual([{ rule: 'S4', transition: 'new' }])
  })

  test('ownedRules guard: stuck detector does not resolve invariant rows', async () => {
    // Seed a fake R1 row to simulate PR-D having found a violation.
    h = await buildHarness('pending', T0 - 10 * MIN_MS)
    await h.db.insert(lifecycleAlerts).values({
      id: ulid(),
      taskId: h.taskId,
      rule: 'R1',
      severity: 'warning',
      detail: '{"rule":"R1"}',
      detectedAt: T0 - 60 * MIN_MS,
      resolvedAt: null,
    })
    // Stuck detector runs — should add S4, NOT touch the R1 row.
    await runStuckTaskDetector({ db: h.db, now: () => T0 })
    const rows = await h.db
      .select()
      .from(lifecycleAlerts)
      .where(eq(lifecycleAlerts.taskId, h.taskId))
    const r1 = rows.find((r) => r.rule === 'R1')!
    expect(r1.resolvedAt).toBeNull() // ← still open
  })
})
