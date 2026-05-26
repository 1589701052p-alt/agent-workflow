// RFC-056 patch 2026-05-22 — Layer B scheduler freshness invariant lock.
//
// Layer A (`triggerDesignerRerun` sibling cascade in `crossClarify.ts`) is
// the primary mechanism: it mints fresh pending rows for every downstream
// node when a cross-clarify resolve fires. Layer B is the defense-in-depth
// invariant inside `runScope`: for every node currently treated as
// `completed` (its latest row is `done`), if any in-scope upstream has a
// strictly greater `clarify_iteration`, the node's done row is
// considered stale and a fresh pending row is minted carrying the
// upstream's iteration. The node is demoted from `completed` back to
// `remaining`.
//
// This catches paths where a designer rerun (or any upstream cross-clarify
// bump) happens OUTSIDE the cascade — manual SQL patches, future
// queue-replay flows, raw DB edits. Without Layer B such state would sit
// silently — the scheduler would advance to the next review with stale
// upstream output and trip `review-source-port-missing`, exactly the live
// failure we just fixed for the cascade case.
//
// LOCKS:
//   1. downstream `done` with clarify_iteration < upstream's
//      clarify_iteration → mint a fresh pending row carrying
//      upstream's iteration; demote node back to `remaining`.
//   2. downstream `done` with clarify_iteration >= upstream's →
//      stays `completed`, NO new row minted (idempotent).
//   3. node with no prior runs at this iteration → skipped (nothing to
//      demote).
//   4. idempotency: invariant called twice in a row mints rows ONLY ONCE.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { and, eq } from 'drizzle-orm'
import type { WorkflowNode } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { applyClarifyFreshnessInvariant } from '../src/services/scheduler'
import { createLogger } from '../src/util/log'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('test-freshness')

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'fresh',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fresh',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/fresh',
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
  fields: Partial<typeof nodeRuns.$inferInsert> = {},
): Promise<typeof nodeRuns.$inferSelect> {
  const id = `nr_${nodeId}_${Math.random().toString(36).slice(2, 8)}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    clarifyIteration: 0,
    ...fields,
  })
  const rows = await db.select().from(nodeRuns).where(eq(nodeRuns.id, id))
  return rows[0]!
}

function makeAgentNode(id: string): WorkflowNode {
  return { id, kind: 'agent-single', agentName: 'whatever' } as WorkflowNode
}

beforeEach(() => {
  resetBroadcastersForTests()
})
afterAll(() => {
  resetBroadcastersForTests()
})

describe('RFC-056 Layer B — applyClarifyFreshnessInvariant', () => {
  test('stale downstream done → fresh pending minted + demoted out of completed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // Upstream designer ran at clarifyIteration=1 (e.g. SQL-patched
    // or manual retry — Layer A wasn't called).
    const designer = await seedRun(db, taskId, 'designer', { clarifyIteration: 1 })
    // Downstream review at clarifyIteration=0 — stale relative to
    // the upstream now.
    const reviewRow = await seedRun(db, taskId, 'review')
    const priorRuns = [designer, reviewRow]
    const latestPerNode = new Map<string, typeof nodeRuns.$inferSelect>([
      ['designer', designer],
      ['review', reviewRow],
    ])
    const completed = new Set<string>(['designer', 'review'])
    const remaining = new Map<string, WorkflowNode>()
    const scopeNodes: WorkflowNode[] = [makeAgentNode('designer'), makeAgentNode('review')]
    const upstreamsOf = new Map<string, string[]>([
      ['designer', []],
      ['review', ['designer']],
    ])
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes,
      upstreamsOf,
      priorRuns,
      latestPerNode,
      completed,
      remaining,
      log,
    })
    // Review demoted out of completed, back into remaining.
    expect(completed.has('review')).toBe(false)
    expect(remaining.has('review')).toBe(true)
    // Fresh pending row exists in the DB at clarifyIteration=1.
    const allReviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))
    expect(allReviewRows.length).toBe(2) // old done + new pending
    const pendingFresh = allReviewRows.find(
      (r) => r.status === 'pending' && r.clarifyIteration === 1,
    )
    expect(pendingFresh).toBeDefined()
  })

  test('downstream already at upstream iteration → no demotion, no mint (idempotent)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const designer = await seedRun(db, taskId, 'designer', { clarifyIteration: 1 })
    const reviewRow = await seedRun(db, taskId, 'review', { clarifyIteration: 1 })
    const priorRuns = [designer, reviewRow]
    const latestPerNode = new Map([
      ['designer', designer],
      ['review', reviewRow],
    ])
    const completed = new Set(['designer', 'review'])
    const remaining = new Map<string, WorkflowNode>()
    const scopeNodes: WorkflowNode[] = [makeAgentNode('designer'), makeAgentNode('review')]
    const upstreamsOf = new Map([
      ['designer', []],
      ['review', ['designer']],
    ])
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes,
      upstreamsOf,
      priorRuns,
      latestPerNode,
      completed,
      remaining,
      log,
    })
    expect(completed.has('review')).toBe(true)
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))
    expect(reviewRows.length).toBe(1) // unchanged
  })

  test('node with no prior runs at this iteration → skipped silently', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const designer = await seedRun(db, taskId, 'designer', { clarifyIteration: 1 })
    // `review` has NO rows at all. It shouldn't be in `completed` in
    // practice — but the invariant tolerates it. (Defensive.)
    const priorRuns = [designer]
    const latestPerNode = new Map([['designer', designer]])
    const completed = new Set<string>()
    const remaining = new Map<string, WorkflowNode>()
    const scopeNodes: WorkflowNode[] = [makeAgentNode('designer'), makeAgentNode('review')]
    const upstreamsOf = new Map([
      ['designer', []],
      ['review', ['designer']],
    ])
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes,
      upstreamsOf,
      priorRuns,
      latestPerNode,
      completed,
      remaining,
      log,
    })
    // No row minted, no state mutated.
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))
    expect(reviewRows.length).toBe(0)
  })

  test('multi-hop chain (designer→A→B→C) gets fully demoted in ONE invocation (fixed-point iteration)', async () => {
    // Live failure shape: cross-clarify resolved → designer reran at
    // clarifyIteration=1, but Layer A's cascade was never minted
    // (pre-patch state in the DB). When the freshness invariant fires on
    // resume, it must walk the full transitive downstream chain — not
    // just the first hop — so the operator doesn't have to manually
    // re-run anything.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const designer = await seedRun(db, taskId, 'designer', { clarifyIteration: 1 })
    const reviewA = await seedRun(db, taskId, 'reviewA')
    const reviewB = await seedRun(db, taskId, 'reviewB')
    const reviewC = await seedRun(db, taskId, 'reviewC')

    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes: [
        makeAgentNode('designer'),
        makeAgentNode('reviewA'),
        makeAgentNode('reviewB'),
        makeAgentNode('reviewC'),
      ] as WorkflowNode[],
      upstreamsOf: new Map([
        ['designer', []],
        ['reviewA', ['designer']],
        ['reviewB', ['reviewA']],
        ['reviewC', ['reviewB']],
      ]),
      priorRuns: [designer, reviewA, reviewB, reviewC],
      latestPerNode: new Map([
        ['designer', designer],
        ['reviewA', reviewA],
        ['reviewB', reviewB],
        ['reviewC', reviewC],
      ]),
      completed: new Set(['designer', 'reviewA', 'reviewB', 'reviewC']),
      remaining: new Map(),
      log,
    })
    // Every downstream node got a fresh pending row at iter=1 in this
    // ONE call. Pre-fix this required N successive scope entries which
    // never happened on a `status=failed` task.
    for (const nodeId of ['reviewA', 'reviewB', 'reviewC']) {
      const rows = await db
        .select()
        .from(nodeRuns)
        .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, nodeId)))
      const pendingFresh = rows.find((r) => r.status === 'pending' && r.clarifyIteration === 1)
      expect(pendingFresh, `${nodeId} should have pending row at iter=1`).toBeDefined()
    }
  })

  test('idempotent across two consecutive invocations — second pass does not double-mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const designer = await seedRun(db, taskId, 'designer', { clarifyIteration: 1 })
    const reviewRow = await seedRun(db, taskId, 'review')
    const buildCtx = () => {
      // Rebuild the ctx fresh each call to mirror how the scheduler
      // would call this — the helper updates `completed` / `remaining`
      // in-place so the second pass sees the post-demotion state.
      return {
        db,
        taskId,
        iteration: 0,
        scopeNodes: [makeAgentNode('designer'), makeAgentNode('review')] as WorkflowNode[],
        upstreamsOf: new Map([
          ['designer', []],
          ['review', ['designer']],
        ]),
        priorRuns: [designer, reviewRow],
        latestPerNode: new Map([
          ['designer', designer],
          ['review', reviewRow],
        ]),
        completed: new Set(['designer', 'review']),
        remaining: new Map<string, WorkflowNode>(),
        log,
      }
    }
    await applyClarifyFreshnessInvariant(buildCtx())
    const afterFirst = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))
    expect(afterFirst.length).toBe(2)
    // Second pass: the priorRuns array we pass now INCLUDES the newly
    // minted pending row (mirrors scheduler re-reading priorRuns on
    // next scope entry). Idempotency guard skips re-mint.
    const allRunsNow = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
    const designerLatest = allRunsNow.find((r) => r.nodeId === 'designer')!
    const reviewLatest = allRunsNow
      .filter((r) => r.nodeId === 'review')
      .sort((a, b) => (b.clarifyIteration ?? 0) - (a.clarifyIteration ?? 0))[0]!
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes: [makeAgentNode('designer'), makeAgentNode('review')] as WorkflowNode[],
      upstreamsOf: new Map([
        ['designer', []],
        ['review', ['designer']],
      ]),
      priorRuns: allRunsNow,
      latestPerNode: new Map([
        ['designer', designerLatest],
        ['review', reviewLatest],
      ]),
      completed: new Set(['designer']),
      remaining: new Map(),
      log,
    })
    const afterSecond = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))
    expect(afterSecond.length, 'second pass must NOT add a new row').toBe(2)
  })
})
