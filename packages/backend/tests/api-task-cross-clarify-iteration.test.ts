// RFC-056 PR-D — locks the REST projection of node_runs.cross_clarify_iteration
// into the wire-level `crossClarifyIteration` field on NodeRun.
//
// Why this test exists: CI run 26275414694 caught the original PR-B's
// `getTaskNodeRuns` mapper omitting this column (the new RFC-056 cross-
// clarify rerun counter), so the e2e A1 happy-path assertion at
// `nodeId === 'designer' && r.crossClarifyIteration === 1` silently
// matched zero rows. The fix added the column to `NodeRunSchema` + the
// mapper; this test guards against a silent re-drop in any future
// `getTaskNodeRuns` refactor.
//
// LOCKS:
//   1. Default (legacy) row → crossClarifyIteration=0 surfaces on the wire.
//   2. Elevated cross-clarify rerun row (crossClarifyIteration=2) → that
//      exact integer surfaces on the wire (not omitted, not silently
//      coerced to 0, not stripped by zod).
//   3. Multiple rows with different cross-clarify iterations preserved
//      pair-wise (the mapper is per-row, not a reduce).
//
// If this goes red the API has silently dropped the RFC-056 iteration
// counter — investigate before relaxing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { getTaskNodeRuns } from '../src/services/task'
import { resetBroadcastersForTests } from '../src/ws/broadcaster'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTaskAndWorkflow(db: DbClient): { taskId: string } {
  const wfId = ulid()
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'wf',
      definition: JSON.stringify({ schemaVersion: 4, name: 'wf', nodes: [], edges: [] }),
      version: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  const taskId = ulid()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 't',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/wt',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
      baseCommit: null,
      status: 'pending',
      inputs: '{}',
      startedAt: Date.now(),
    })
    .run()
  return { taskId }
}

function seedRun(
  db: DbClient,
  taskId: string,
  opts: { nodeId?: string; crossClarifyIteration?: number; clarifyIteration?: number } = {},
): string {
  const id = ulid()
  db.insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId: opts.nodeId ?? 'designer',
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: opts.clarifyIteration ?? 0,
      crossClarifyIteration: opts.crossClarifyIteration ?? 0,
      status: 'done',
      startedAt: Date.now(),
    })
    .run()
  return id
}

describe('RFC-056 — getTaskNodeRuns surfaces crossClarifyIteration', () => {
  let db: DbClient
  beforeEach(() => {
    resetBroadcastersForTests()
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('A1: legacy row surfaces crossClarifyIteration=0 on the wire', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, { crossClarifyIteration: 0 })
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.length).toBe(1)
    expect(res.runs[0]?.crossClarifyIteration).toBe(0)
  })

  test('A2: elevated row surfaces the exact integer (no zod strip, no coerce)', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, { crossClarifyIteration: 2 })
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.length).toBe(1)
    expect(res.runs[0]?.crossClarifyIteration).toBe(2)
  })

  test('A3: multiple rows preserved pair-wise per row (mapper is per-row)', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, { nodeId: 'designer', crossClarifyIteration: 0 })
    seedRun(db, taskId, { nodeId: 'designer', crossClarifyIteration: 1 })
    seedRun(db, taskId, { nodeId: 'designer', crossClarifyIteration: 3 })
    const res = await getTaskNodeRuns(db, taskId)
    const values = res.runs.map((r) => r.crossClarifyIteration).sort((a, b) => a - b)
    expect(values).toEqual([0, 1, 3])
  })

  test('A4: clarifyIteration / crossClarifyIteration are independent on the wire', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, { clarifyIteration: 5, crossClarifyIteration: 0 })
    seedRun(db, taskId, { clarifyIteration: 0, crossClarifyIteration: 5 })
    const res = await getTaskNodeRuns(db, taskId)
    const sorted = [...res.runs].sort((a, b) => a.clarifyIteration - b.clarifyIteration)
    expect(sorted[0]?.clarifyIteration).toBe(0)
    expect(sorted[0]?.crossClarifyIteration).toBe(5)
    expect(sorted[1]?.clarifyIteration).toBe(5)
    expect(sorted[1]?.crossClarifyIteration).toBe(0)
  })
})
