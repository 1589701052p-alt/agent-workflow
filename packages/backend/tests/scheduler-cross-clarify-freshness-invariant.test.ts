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

// RFC-074 PR-A baseline — freshness observable locks (A7-A12).
//
// WHY THIS BLOCK EXISTS (regression intent):
//   The describe above + `cross-clarify-downstream-cascade.test.ts` (Layer A)
//   already lock the core demote/cascade/idempotency behavior. These cases add
//   the freshness behaviors PR-B will lean on but that were NOT yet pinned:
//   loop-iteration scoping of the mint (PR-B T-B6b), diamond fan-in max-cci
//   selection (the S12 topology), and Layer-A∘Layer-B composition (no
//   double-mint when a cascade row already exists). They assert the CURRENT
//   cci-based behavior; PR-B's provenance rewrite must keep the observable
//   results (demoted set, minted iteration, no double-mint) identical.
describe('RFC-074 PR-A baseline — freshness observable (A7-A12)', () => {
  // A7 — loop-iteration scoping. A node with done rows in TWO loop iterations
  // must demote only within the scope's iteration: the mint's retryIndex is
  // computed from this-iteration rows and the new pending carries this
  // iteration; the other iteration's row is untouched. Locks the
  // `r.iteration === ctx.iteration` filter (scheduler.ts ~964) that PR-B's
  // freshestDone iteration scoping (T-B6b) replaces.
  test('A7: demote is scoped to ctx.iteration — other-iteration rows untouched', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const designer = await seedRun(db, taskId, 'designer', { iteration: 1, clarifyIteration: 1 })
    const reviewIter1 = await seedRun(db, taskId, 'review', { iteration: 1, clarifyIteration: 0 })
    // An older loop iteration's done row — must NOT be considered or mutated.
    await seedRun(db, taskId, 'review', { iteration: 0, clarifyIteration: 0 })
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 1,
      scopeNodes: [makeAgentNode('designer'), makeAgentNode('review')],
      upstreamsOf: new Map([
        ['designer', []],
        ['review', ['designer']],
      ]),
      priorRuns: [
        designer,
        reviewIter1,
        ...(await db
          .select()
          .from(nodeRuns)
          .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))),
      ],
      latestPerNode: new Map([
        ['designer', designer],
        ['review', reviewIter1],
      ]),
      completed: new Set(['designer', 'review']),
      remaining: new Map(),
      log,
    })
    const iter1Rows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review'), eq(nodeRuns.iteration, 1)),
      )
    const freshPending = iter1Rows.find((r) => r.status === 'pending' && r.clarifyIteration === 1)
    expect(freshPending, 'fresh pending minted at iteration=1, cci=1').toBeDefined()
    // The iteration=0 row is still exactly one row, untouched.
    const iter0Rows = await db
      .select()
      .from(nodeRuns)
      .where(
        and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review'), eq(nodeRuns.iteration, 0)),
      )
    expect(iter0Rows.length, 'other-iteration row untouched').toBe(1)
  })

  // A8a — diamond fan-in: a node demotes when the MAX cci across its multiple
  // upstreams exceeds its own (one bumped upstream is enough). This is the S12
  // topology where the silent rerun bites.
  test('A8a: diamond fan-in — max upstream cci wins → demote', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const a = await seedRun(db, taskId, 'A', { clarifyIteration: 2 })
    const b = await seedRun(db, taskId, 'B', { clarifyIteration: 0 })
    const merge = await seedRun(db, taskId, 'merge', { clarifyIteration: 1 })
    const completed = new Set(['A', 'B', 'merge'])
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes: [makeAgentNode('A'), makeAgentNode('B'), makeAgentNode('merge')],
      upstreamsOf: new Map([
        ['A', []],
        ['B', []],
        ['merge', ['A', 'B']],
      ]),
      priorRuns: [a, b, merge],
      latestPerNode: new Map([
        ['A', a],
        ['B', b],
        ['merge', merge],
      ]),
      completed,
      remaining: new Map(),
      log,
    })
    expect(completed.has('merge')).toBe(false)
    const mergeRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'merge')))
    expect(mergeRows.find((r) => r.status === 'pending' && r.clarifyIteration === 2)).toBeDefined()
  })

  // A8b — diamond fan-in: when no upstream exceeds the node's cci, it stays
  // completed and nothing is minted (idempotent across equal generations).
  test('A8b: diamond fan-in — all upstreams <= node cci → no demote', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const a = await seedRun(db, taskId, 'A', { clarifyIteration: 1 })
    const b = await seedRun(db, taskId, 'B', { clarifyIteration: 1 })
    const merge = await seedRun(db, taskId, 'merge', { clarifyIteration: 1 })
    const completed = new Set(['A', 'B', 'merge'])
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes: [makeAgentNode('A'), makeAgentNode('B'), makeAgentNode('merge')],
      upstreamsOf: new Map([
        ['A', []],
        ['B', []],
        ['merge', ['A', 'B']],
      ]),
      priorRuns: [a, b, merge],
      latestPerNode: new Map([
        ['A', a],
        ['B', b],
        ['merge', merge],
      ]),
      completed,
      remaining: new Map(),
      log,
    })
    expect(completed.has('merge')).toBe(true)
    const mergeRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'merge')))
    expect(mergeRows.length).toBe(1)
  })

  // A9 — Layer A ∘ Layer B composition. When the cross-clarify cascade
  // (Layer A) already minted a fresh pending row for a downstream node, that
  // node's latest row is pending → it is in `remaining`, NOT `completed`. The
  // freshness invariant only walks `completed`, so it must NOT mint a second
  // pending row. Locks the no-double-mint guarantee between the two layers.
  test('A9: Layer-A pending already minted → Layer B does not double-mint', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const designer = await seedRun(db, taskId, 'designer', { clarifyIteration: 1 })
    await seedRun(db, taskId, 'review', { clarifyIteration: 0 }) // old done
    const cascadePending = await seedRun(db, taskId, 'review', {
      clarifyIteration: 1,
      retryIndex: 1,
      status: 'pending',
    }) // Layer A cascade output
    const completed = new Set(['designer']) // review is NOT completed (latest is pending)
    const remaining = new Map([['review', makeAgentNode('review')]])
    await applyClarifyFreshnessInvariant({
      db,
      taskId,
      iteration: 0,
      scopeNodes: [makeAgentNode('designer'), makeAgentNode('review')],
      upstreamsOf: new Map([
        ['designer', []],
        ['review', ['designer']],
      ]),
      priorRuns: [designer, cascadePending],
      latestPerNode: new Map([
        ['designer', designer],
        ['review', cascadePending],
      ]),
      completed,
      remaining,
      log,
    })
    const reviewRows = await db
      .select()
      .from(nodeRuns)
      .where(and(eq(nodeRuns.taskId, taskId), eq(nodeRuns.nodeId, 'review')))
    expect(reviewRows.length, 'no second pending minted by Layer B').toBe(2)
  })
})
