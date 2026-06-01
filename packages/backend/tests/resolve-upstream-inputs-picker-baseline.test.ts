// RFC-074 PR-A baseline — `resolveUpstreamInputs` CURRENT row-selection, locked.
//
// WHY THIS FILE EXISTS (regression intent, design §5.1 / decision D10):
//   `resolveUpstreamInputs` is the SINGLE place an agent node reads its
//   upstream content. Today it selects the source run by
//   `(iteration desc, retryIndex desc)` — with NO cci term and NO status
//   filter — whereas the freshness machinery (`isFresherNodeRun`,
//   `latestPerNode`) selects by `(cci, retryIndex, id)`. That divergence is
//   the "three-picker drift" the RFC indicts: the row a node ACTUALLY reads
//   can differ from the row freshness believes is newest.
//
//   PR-B unifies this picker with `freshestDone` (and filters to done rows),
//   which is a BEHAVIOR CHANGE that fixes a latent stale-read bug. Per D10 we
//   must first LOCK the current selection so each flipped assertion in PR-B is
//   audited as "corrected stale read" vs "regression". These tests therefore
//   assert the CURRENT (cci-blind) behavior on purpose — including the bug.
//   When PR-B makes them RED, that is the expected, audited flip.
//
//   `resolveUpstreamInputs` was made `export` in PR-A solely to enable this
//   lock (behavior-preserving — see scheduler.ts).

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import type { WorkflowEdge } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, nodeRunOutputs, tasks, workflows } from '../src/db/schema'
import { resolveUpstreamInputs } from '../src/services/scheduler'
import { createLogger } from '../src/util/log'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const log = createLogger('test-picker-baseline')

async function seedTask(db: DbClient): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: wfId,
    name: 'pick',
    description: '',
    definition: '{}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'pick',
    workflowId: wfId,
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '',
    baseBranch: 'main',
    branch: 'agent-workflow/pick',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

let seq = 0
// Seed a top-level node_run plus one output port, returning the run id. `id` is
// passed explicitly so tests control ULID ordering deterministically.
async function seedRunWithOutput(
  db: DbClient,
  taskId: string,
  nodeId: string,
  fields: {
    id: string
    iteration?: number
    retryIndex?: number
    clarifyIteration?: number
    status?: string
    parentNodeRunId?: string | null
  },
  outputs: Record<string, string>,
): Promise<string> {
  await db.insert(nodeRuns).values({
    id: fields.id,
    taskId,
    nodeId,
    status: (fields.status ?? 'done') as 'done',
    retryIndex: fields.retryIndex ?? 0,
    iteration: fields.iteration ?? 0,
    clarifyIteration: fields.clarifyIteration ?? 0,
    parentNodeRunId: fields.parentNodeRunId ?? null,
  })
  for (const [portName, content] of Object.entries(outputs)) {
    await db.insert(nodeRunOutputs).values({ nodeRunId: fields.id, portName, content })
  }
  return fields.id
}

function edge(
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): WorkflowEdge {
  seq += 1
  return {
    id: `e${seq}`,
    source: { nodeId: sourceNodeId, portName: sourcePort },
    target: { nodeId: targetNodeId, portName: targetPort },
  }
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-074 PR-A baseline — resolveUpstreamInputs current (iteration,retryIndex) picker', () => {
  // PB1 — THE HEADLINE LATENT BUG (design §5.1). Upstream has two top-level
  // done rows at the same iteration: a retry-storm row at the OLD generation
  // (cci=0, retry=5) and the post-clarify rerun (cci=1, retry=0). The picker
  // sorts by retryIndex desc and IGNORES cci, so it reads the STALE
  // pre-clarify content. PR-B flips this to the fresh row.
  test('PB1: cci-blind — picks higher retryIndex (STALE pre-clarify) over fresh clarify rerun', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    // gen0 retry-storm done row — LARGER retryIndex.
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01STALE', iteration: 0, retryIndex: 5, clarifyIteration: 0, status: 'done' },
      { spec: 'STALE-pre-clarify' },
    )
    // gen1 clarify rerun — freshest generation but retryIndex=0.
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01FRESH', iteration: 0, retryIndex: 0, clarifyIteration: 1, status: 'done' },
      { spec: 'FRESH-post-clarify' },
    )
    const inputs = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('designer', 'spec', 'review', 'doc')],
      'review',
      0,
      log,
    )
    // LOCKED CURRENT BEHAVIOR: the stale, higher-retry row wins. (PR-B: FRESH.)
    expect(inputs.doc).toBe('STALE-pre-clarify')
  })

  // PB2 — no status filter. A non-done row (here: a pending rerun with no
  // output yet) at higher retryIndex shadows a done row with real content,
  // yielding EMPTY input. PR-B's done-only filter fixes this.
  test('PB2: no status filter — pending higher-retry row shadows done content (empty result)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01DONE', iteration: 0, retryIndex: 0, status: 'done' },
      { spec: 'real-content' },
    )
    // Pending rerun, higher retryIndex, no outputs persisted yet.
    await seedRunWithOutput(
      db,
      taskId,
      'designer',
      { id: '01PEND', iteration: 0, retryIndex: 1, status: 'pending' },
      {},
    )
    const inputs = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('designer', 'spec', 'review', 'doc')],
      'review',
      0,
      log,
    )
    // LOCKED: picker chose the pending row → port missing → empty string.
    expect(inputs.doc).toBe('')
  })

  // PB3 — iteration windowing. Rows with iteration > target are excluded; among
  // iteration <= target the highest iteration wins. Resolving at iter 0 must
  // NOT see iter 1's content; resolving at iter 1 sees iter 1.
  test('PB3: iteration windowing — iteration <= target, highest in-window wins', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'builder',
      { id: '01ITER0', iteration: 0, retryIndex: 0, status: 'done' },
      { out: 'ITER0' },
    )
    await seedRunWithOutput(
      db,
      taskId,
      'builder',
      { id: '01ITER1', iteration: 1, retryIndex: 0, status: 'done' },
      { out: 'ITER1' },
    )
    const e = [edge('builder', 'out', 'sink', 'in')]
    expect((await resolveUpstreamInputs(db, taskId, e, 'sink', 0, log)).in).toBe('ITER0')
    expect((await resolveUpstreamInputs(db, taskId, e, 'sink', 1, log)).in).toBe('ITER1')
  })

  // PB4 — multi-source join + child-row exclusion. Two upstream nodes feed the
  // same target port → contents joined with the framework separator; a child
  // (parentNodeRunId != null) shard row is excluded from top-level selection.
  test('PB4: two sources joined; child shard rows excluded from selection', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedRunWithOutput(
      db,
      taskId,
      'a',
      { id: '01A', iteration: 0, status: 'done' },
      { o: 'AAA' },
    )
    await seedRunWithOutput(
      db,
      taskId,
      'b',
      { id: '01B', iteration: 0, status: 'done' },
      { o: 'BBB' },
    )
    // A child shard row under 'a' with a higher retryIndex — must be ignored
    // because parentNodeRunId != null (top-level filter).
    await seedRunWithOutput(
      db,
      taskId,
      'a',
      { id: '01ACHILD', iteration: 0, retryIndex: 9, status: 'done', parentNodeRunId: '01A' },
      { o: 'CHILD-should-not-win' },
    )
    const inputs = await resolveUpstreamInputs(
      db,
      taskId,
      [edge('a', 'o', 'sink', 'merged'), edge('b', 'o', 'sink', 'merged')],
      'sink',
      0,
      log,
    )
    expect(inputs.merged).toBe('AAA\n\n---\n\nBBB')
  })
})
