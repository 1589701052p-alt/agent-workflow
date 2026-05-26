// RFC-056 patch 2026-05-25 — `isFresherForCutoff` (local copy of
// `isFresherNodeRun` in clarifyRounds.ts) must also consult
// clarifyIteration.
//
// `computeHistoryCutoff` walks all node_runs of the consumer node and
// uses `isFresherForCutoff` to pick the freshest prior-completed row.
// Pre-patch the comparator skipped `clarifyIteration`, so a
// (cli=0, cci=1, retry=0) prior cross-clarify done row would be
// shadowed by a (cli=0, cci=0, retry=1) `<workflow-clarify>`-only done
// row from an earlier RFC-042 followup — the cutoff would return 0
// instead of 1 and the aging filter would leak the older Q&A rounds
// back into the prompt.
//
// Same root cause as the scheduler.ts comparator bug; same fix
// (add cci as a tiebreaker between cli and retryIndex). This file
// locks the cutoff side of the fix.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'

import { createInMemoryDb } from '../src/db/client'
import { nodeRunOutputs, nodeRuns, tasks, workflows } from '../src/db/schema'
import { computeHistoryCutoff } from '../src/services/clarifyRounds'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const taskId = `task_${Math.random().toString(36).slice(2, 8)}`
  const definition: WorkflowDefinition = {
    $schema_version: 4,
    inputs: [],
    nodes: [{ id: 'designer', kind: 'agent-single', agentName: 'designer' } as WorkflowNode],
    edges: [],
    outputs: [],
  }
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'cutoff-cci',
    description: '',
    definition: JSON.stringify(definition),
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'cutoff-cci',
    workflowId,
    workflowSnapshot: JSON.stringify(definition),
    repoPath: '/tmp/aw-cutoff-cci',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

beforeEach(() => resetBroadcastersForTests())
afterAll(() => resetBroadcastersForTests())

describe('RFC-056 patch 2026-05-25 — isFresherForCutoff must consult clarifyIteration', () => {
  test('cci-bumped done with outputs beats prior cci=0 retry-bumped done with outputs', async () => {
    // Seed two prior done rows on `designer`:
    //   - cci=0, retry=1, has outputs (pre-cross-clarify RFC-042 followup
    //     storm — outputs present so it doesn't get filtered for lack of
    //     port content)
    //   - cci=1, retry=0, has outputs (post-cross-clarify rerun's output)
    // The about-to-run row sits at cci=2 (e.g. a second cross-clarify
    // round). The cutoff must return the newer cci=1 row's value, so the
    // aging filter drops every clarify_rounds row with iteration < 1.
    // Pre-patch the comparator picked retry=1 over cci=1 → cutoff=0 →
    // leaked the entire prior history back into the prompt.
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)

    await db.insert(nodeRuns).values({
      id: 'nr_old_high_retry',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 1,
      iteration: 0,
      clarifyIteration: 0,
      startedAt: Date.now() - 2000,
      finishedAt: Date.now() - 1500,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_old_high_retry',
      portName: 'plan',
      content: 'first cross-clarify rerun output',
    })

    await db.insert(nodeRuns).values({
      id: 'nr_new_cci_one',
      taskId,
      nodeId: 'designer',
      status: 'done',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
      startedAt: Date.now() - 1000,
      finishedAt: Date.now() - 500,
    })
    await db.insert(nodeRunOutputs).values({
      nodeRunId: 'nr_new_cci_one',
      portName: 'plan',
      content: 'second cross-clarify rerun output',
    })

    await db.insert(nodeRuns).values({
      id: 'nr_current',
      taskId,
      nodeId: 'designer',
      status: 'pending',
      retryIndex: 0,
      iteration: 0,
      clarifyIteration: 0,
    })
    const current = (await db.select().from(nodeRuns).where(eq(nodeRuns.id, 'nr_current')))[0]!

    const cutoff = await computeHistoryCutoff({
      db,
      taskId,
      nodeId: 'designer',
      currentRunRow: current,
      shardKey: null,
    })
    expect(cutoff).toBe(1)
  })
})
