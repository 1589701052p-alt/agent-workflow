// RFC-056 §10 + RFC-053 — CR-1 invariant for cross_clarify_sessions.
//
// CR-1 rule:
//   cross_clarify_sessions.status = 'answered'
//   AND directive = 'continue'
//   AND target_designer_node_id IS NOT NULL
//   AND task.status = 'failed'
//   AND no designer node_run exists with status='done'
//       AND cross_clarify_iteration >= session.iteration
//   ⟹ AUTO-UPGRADE session to status='abandoned' + abandoned_at=now()
//
// LOCKS:
//   1. happy upgrade: task=failed + answered+continue + no consuming designer
//      → row becomes abandoned + abandoned_at is non-null.
//   2. idempotent re-scan: running invariants twice produces no double-upgrade
//      (the second pass sees status='abandoned' and skips).
//   3. does NOT mis-upgrade in-flight sessions: task=running OR a consuming
//      designer node_run exists → row stays 'answered'.
//
// If any of these go red the abandoned-state safety net for cross-clarify
// is broken — investigate before relaxing.

import { afterEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'

import type { WorkflowDefinition } from '@agent-workflow/shared'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import { clarifyRounds, crossClarifySessions, nodeRuns, tasks, workflows } from '../src/db/schema'
import { runLifecycleInvariants } from '../src/services/lifecycleInvariants'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  taskId: string
  workflowId: string
  cleanup: () => void
}

function defaultDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: [
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
      { id: 'questioner', kind: 'agent-single', agentName: 'questioner' },
      { id: 'cross1', kind: 'clarify-cross-agent' },
    ],
    edges: [
      {
        id: 'e_q_c',
        source: { nodeId: 'questioner', portName: '__clarify__' },
        target: { nodeId: 'cross1', portName: 'questions' },
      },
      {
        id: 'e_c_d',
        source: { nodeId: 'cross1', portName: 'to_designer' },
        target: { nodeId: 'designer', portName: '__external_feedback__' },
      },
    ],
    outputs: [],
  }
}

async function buildHarness(taskStatus: 'running' | 'failed' | 'done'): Promise<Harness> {
  const tmp = mkdtempSync(join(tmpdir(), 'aw-rfc056-cr1-'))
  mkdirSync(tmp, { recursive: true })
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const def = defaultDef()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'w',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
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
    status: taskStatus,
    inputs: '{}',
    startedAt: Date.now() - 100_000,
    finishedAt: taskStatus === 'failed' || taskStatus === 'done' ? Date.now() - 1_000 : null,
  })
  return { db, taskId, workflowId, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
}

async function seedSession(
  db: DbClient,
  taskId: string,
  opts: {
    status?: 'awaiting_human' | 'answered' | 'abandoned'
    directive?: 'continue' | 'stop' | null
    iteration?: number
    targetDesignerNodeId?: string | null
  } = {},
): Promise<string> {
  const sessionId = ulid()
  const crossClarifyNodeRunId = ulid()
  const questionerRunId = ulid()
  // FK targets — minimal stub node_runs.
  await db.insert(nodeRuns).values({
    id: crossClarifyNodeRunId,
    taskId,
    nodeId: 'cross1',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    crossClarifyIteration: opts.iteration ?? 0,
  })
  await db.insert(nodeRuns).values({
    id: questionerRunId,
    taskId,
    nodeId: 'questioner',
    status: 'done',
    retryIndex: 0,
    iteration: 0,
  })
  const directive = opts.directive === undefined ? 'continue' : opts.directive
  const status = opts.status ?? 'answered'
  const iteration = opts.iteration ?? 0
  const targetDesignerNodeId =
    opts.targetDesignerNodeId === undefined ? 'designer' : opts.targetDesignerNodeId
  const createdAt = Date.now() - 50_000
  const answeredAt = Date.now() - 30_000
  await db.insert(crossClarifySessions).values({
    id: sessionId,
    taskId,
    crossClarifyNodeId: 'cross1',
    crossClarifyNodeRunId,
    sourceQuestionerNodeId: 'questioner',
    sourceQuestionerNodeRunId: questionerRunId,
    targetDesignerNodeId,
    loopIter: 0,
    iteration,
    questionsJson: '[{"id":"q1","title":"t","kind":"single","recommended":false,"options":[]}]',
    answersJson: '[]',
    directive,
    status,
    createdAt,
    answeredAt,
  })
  // RFC-058 T15: CR-1 invariant now reads `clarify_rounds WHERE kind='cross'`
  // — mirror the seed onto the unified table so the rule observes it (matches
  // the dual-write that createCrossClarifySession does in production).
  await db.insert(clarifyRounds).values({
    id: sessionId,
    taskId,
    kind: 'cross',
    askingNodeId: 'questioner',
    askingNodeRunId: questionerRunId,
    askingShardKey: null,
    intermediaryNodeId: 'cross1',
    intermediaryNodeRunId: crossClarifyNodeRunId,
    targetConsumerNodeId: targetDesignerNodeId,
    loopIter: 0,
    iteration,
    questionsJson: '[{"id":"q1","title":"t","kind":"single","recommended":false,"options":[]}]',
    answersJson: '[]',
    directive,
    status,
    truncationWarningsJson: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    createdAt,
    answeredAt,
    answeredBy: null,
  })
  return sessionId
}

let h: Harness | null = null

afterEach(() => {
  h?.cleanup()
  h = null
})

describe('RFC-056 CR-1 invariant', () => {
  test('happy upgrade: task=failed + answered+continue + no consuming designer → abandoned', async () => {
    h = await buildHarness('failed')
    const sessionId = await seedSession(h.db, h.taskId, {
      status: 'answered',
      directive: 'continue',
      iteration: 0,
    })
    const ret = await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    expect(ret.openAlerts.some((a) => a.rule === 'CR-1')).toBe(true)

    const row = (
      await h.db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, sessionId))
    )[0]
    expect(row?.status).toBe('abandoned')
    expect(row?.abandonedAt).not.toBeNull()
  })

  test('idempotent re-scan: second pass produces no double-upgrade (status already abandoned → skip)', async () => {
    h = await buildHarness('failed')
    const sessionId = await seedSession(h.db, h.taskId, {
      status: 'answered',
      directive: 'continue',
      iteration: 0,
    })
    await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const firstAbandonedAt = (
      await h.db
        .select({ abandonedAt: crossClarifySessions.abandonedAt })
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.id, sessionId))
    )[0]?.abandonedAt
    expect(firstAbandonedAt).not.toBeNull()

    // Second scan — should not stamp abandoned_at a second time (the rule
    // selects WHERE status='answered'; abandoned rows are excluded).
    await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const secondAbandonedAt = (
      await h.db
        .select({ abandonedAt: crossClarifySessions.abandonedAt })
        .from(crossClarifySessions)
        .where(eq(crossClarifySessions.id, sessionId))
    )[0]?.abandonedAt
    expect(secondAbandonedAt).toBe(firstAbandonedAt)
  })

  test('does NOT mis-upgrade when task=running (in-flight)', async () => {
    h = await buildHarness('running')
    const sessionId = await seedSession(h.db, h.taskId, {
      status: 'answered',
      directive: 'continue',
      iteration: 0,
    })
    await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const row = (
      await h.db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, sessionId))
    )[0]
    expect(row?.status).toBe('answered')
    expect(row?.abandonedAt).toBeNull()
  })

  test('does NOT mis-upgrade when a consuming designer node_run exists at cross_clarify_iteration > session.iteration', async () => {
    h = await buildHarness('failed')
    const sessionId = await seedSession(h.db, h.taskId, {
      status: 'answered',
      directive: 'continue',
      iteration: 0,
    })
    // The designer DID consume this feedback before the task failed.
    await h.db.insert(nodeRuns).values({
      id: ulid(),
      taskId: h.taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      crossClarifyIteration: 1,
    })
    await runLifecycleInvariants({ db: h.db, scope: { taskId: h.taskId } })
    const row = (
      await h.db.select().from(crossClarifySessions).where(eq(crossClarifySessions.id, sessionId))
    )[0]
    expect(row?.status).toBe('answered')
    expect(row?.abandonedAt).toBeNull()
  })
})
