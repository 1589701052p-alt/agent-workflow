// LOCKS: RFC-096 (audit S-13 / 附录 C #7) — triggerDesignerRerun row selection.
//
// `triggerDesignerRerun` (crossClarify.ts) anchors EVERYTHING on the
// "latest designer node_run": the minted pending row's inherited iteration /
// reviewIteration / shardKey / parentNodeRunId, and the retry-index bump
// scope. Before RFC-096 it picked
// that row with SQL `desc(startedAt)`, which had two live pathologies this
// file locks the fixes for (red before the fix):
//
//   1. NULL-startedAt sinks — freshly minted rerun rows (review / cross-
//      clarify mint pending rows WITHOUT writing startedAt) sort LAST under
//      DESC, so a second trigger re-picked the STALE old row and anchored
//      inheritance on the wrong generation.
//   2. mark-running startedAt rewrite — a resumed old-iteration row jumps to
//      the front of the startedAt order, again hijacking the anchor.
//
// The fix: load all (taskId, nodeId) rows and pick via the shared
// `pickFreshestRun(rows, { topLevelOnly: false })` — pure ULID id order.
// `topLevelOnly: false` is deliberate (NOT the picker default): a designer
// inside a wrapper-fanout lives on shard CHILD rows and its rerun must
// inherit shardKey + parentNodeRunId. cross-clarify-service.test.ts
// ('preserves shard_key + parent_node_run_id passthrough') locks the
// passthrough; this file locks the complementary PICKER angle — child rows
// stay in the candidate set.
//
// Fixture pattern mirrors cross-clarify-designer-retry-index.test.ts:
// seedRun mints MONOTONIC ids (seeding order = causal order = id order, the
// invariant production ULIDs provide). Seeded `nr_*` ids are always larger
// than production ULIDs ('n' > '0'-'9'), which is fine: the pick happens
// BEFORE the production mint.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { triggerDesignerRerun } from '../src/services/crossClarify'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function fixtureDef(): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [{ kind: 'text', key: 'requirement', label: 'r' }],
    nodes: [
      { id: 'in', kind: 'input' },
      { id: 'designer', kind: 'agent-single', agentName: 'designer' },
    ],
    edges: [
      {
        id: 'e_in_d',
        source: { nodeId: 'in', portName: 'requirement' },
        target: { nodeId: 'designer', portName: 'requirement' },
      },
    ],
    outputs: [],
  }
}

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const def = fixtureDef()
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'rfc096-designer-rerun-pick',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'fixture-task',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-rfc096-designer-rerun-pick',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

// Monotonic seeded ids (cross-clarify-designer-retry-index.test.ts pattern).
let seedSeq = 0
async function seedRun(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: Partial<typeof nodeRuns.$inferInsert>,
): Promise<string> {
  seedSeq += 1
  const id = `nr_${String(seedSeq).padStart(4, '0')}_${nodeId}`
  await db.insert(nodeRuns).values({
    id,
    taskId,
    nodeId,
    status: 'done',
    retryIndex: 0,
    iteration: 0,
    ...fields,
  })
  return id
}

async function loadRun(db: DbClient, id: string) {
  return (await db.select().from(nodeRuns).where(eq(nodeRuns.id, id)))[0]
}

describe('RFC-096 triggerDesignerRerun — freshest-row pick (pure id order)', () => {
  test('core lock: NULL-startedAt freshly-minted rerun row beats a stale row with huge startedAt', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // Stale generation: done long ago but startedAt is HUGE (under the old
    // desc(startedAt) pick it always won; NULL startedAt sorted dead last).
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      iteration: 0,
      reviewIteration: 0,
      startedAt: 9_999_999_999_999,
      preSnapshot: 'snap-stale',
    })
    // Freshly-minted rerun row (the shape review.ts / crossClarify.ts mint):
    // larger id, startedAt OMITTED → NULL. This is the causal latest.
    await seedRun(db, taskId, 'designer', {
      status: 'pending',
      iteration: 1,
      reviewIteration: 3,
      preSnapshot: 'snap-fresh',
      // startedAt deliberately absent → NULL
    })

    const ret = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [],
      loopIter: 1,
    })

    // The minted pending row inherits every anchor field from the NULL-
    // startedAt row — proof the picker chose it (red before RFC-096: all of
    // these came from the stale iteration-0 / snap-stale row).
    const minted = await loadRun(db, ret.designerNodeRunId)
    expect(minted?.status).toBe('pending')
    expect(minted?.iteration).toBe(1)
    expect(minted?.reviewIteration).toBe(3)
    expect(minted?.preSnapshot).toBe('snap-fresh')
    // Bump scope = top-level rows at the ANCHOR's iteration (=1): only the
    // fresh row (retry 0) → max+1 = 1. Under the stale anchor this would have
    // been computed over iteration 0 instead.
    expect(minted?.retryIndex).toBe(1)
  })

  test('mark-running drift immunity: old-iteration row with rewritten (max) startedAt does not hijack the anchor', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // Resumed old-iteration row whose startedAt was REWRITTEN by mark-running
    // to "now" — the largest startedAt in the table.
    await seedRun(db, taskId, 'designer', {
      status: 'running',
      iteration: 0,
      startedAt: 9_999_999_999_999,
      preSnapshot: 'snap-old-iter0',
    })
    // Causally newer generation at iteration 1 (larger id, small startedAt).
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      iteration: 1,
      startedAt: 1_000,
      preSnapshot: 'snap-new-iter1',
    })

    const ret = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [],
      loopIter: 1,
    })

    const minted = await loadRun(db, ret.designerNodeRunId)
    expect(minted?.iteration).toBe(1)
    expect(minted?.preSnapshot).toBe('snap-new-iter1')
    expect(minted?.retryIndex).toBe(1) // bump over iteration-1's single retry-0 row
  })

  test('child-row feature: a fanout designer with ONLY a shard child row stays selectable (topLevelOnly:false)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // The picker's DEFAULT (topLevelOnly:true) would return undefined here and
    // the trigger would throw not-found — this case pins the deliberate
    // { topLevelOnly: false } in crossClarify.ts.
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      iteration: 0,
      parentNodeRunId: 'parent-x',
      shardKey: 'shardA',
      preSnapshot: 'snap-shard',
    })

    const ret = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [],
      loopIter: 0,
    })

    const minted = await loadRun(db, ret.designerNodeRunId)
    expect(minted?.parentNodeRunId).toBe('parent-x')
    expect(minted?.shardKey).toBe('shardA')
    expect(minted?.preSnapshot).toBe('snap-shard')
    // Bump scope counts TOP-LEVEL rows at the anchor iteration; there are
    // none (the only row is a child) → minted retryIndex = 0.
    expect(minted?.retryIndex).toBe(0)
  })

  test('mixed rows: the id-freshest row wins even when it is a CHILD row (picker does not filter parent)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    // Older top-level row with a huge startedAt (both legacy orderings —
    // desc(startedAt) and any top-level-only pick — would choose this one).
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      iteration: 0,
      startedAt: 9_999_999_999_999,
      preSnapshot: 'snap-top',
    })
    // Causally newest row is a shard child (larger id, NULL startedAt).
    await seedRun(db, taskId, 'designer', {
      status: 'done',
      iteration: 0,
      parentNodeRunId: 'parent-y',
      shardKey: 'shardB',
      preSnapshot: 'snap-child',
    })

    const ret = await triggerDesignerRerun({
      db,
      taskId,
      designerNodeId: 'designer',
      sources: [],
      loopIter: 0,
    })

    const minted = await loadRun(db, ret.designerNodeRunId)
    expect(minted?.parentNodeRunId).toBe('parent-y')
    expect(minted?.shardKey).toBe('shardB')
    expect(minted?.preSnapshot).toBe('snap-child')
    // Bump still scans TOP-LEVEL rows at the anchor iteration (the retry-0
    // top-level row exists) → 0 + 1 = 1.
    expect(minted?.retryIndex).toBe(1)
  })
})
