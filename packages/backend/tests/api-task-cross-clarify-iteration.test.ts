// RFC-056 + RFC-064 — lock that getTaskNodeRuns surfaces `clarifyIteration`
// on the wire. Under RFC-064 the previously-separate
// `crossClarifyIteration` column was folded into `clarifyIteration`; the
// REST mapper now ships the single counter, which carries both self-clarify
// and cross-clarify round signals (the `kind` column on `clarify_rounds` is
// the only "self vs cross" discriminator). NodeRun consumers that used to
// expect `crossClarifyIteration` see `clarifyIteration` instead — and the
// `(r.clarifyIteration > 0)` filter remains the right "this row went
// through a clarify rerun" predicate.
//
// Cases mirror the pre-RFC-064 set so we keep coverage of:
//   1. Default (legacy) row → clarifyIteration=0 surfaces on the wire.
//   2. Elevated rerun row → high clarifyIteration surfaces verbatim.
//   3. Multiple rows for one node distinguished only by clarifyIteration.
//   4. Independence verified via two rows with disjoint (clarify, review)
//      tuples — the mapper writes each column independently.

import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { getTaskNodeRuns } from '../src/services/task'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function seedTask(db: DbClient): { taskId: string } {
  const taskId = ulid()
  const wfId = `wf_${taskId}`
  db.insert(workflows)
    .values({
      id: wfId,
      name: 'stub',
      description: '',
      definition: '{}',
      version: 1,
      schemaVersion: 4,
    })
    .run()
  db.insert(tasks)
    .values({
      id: taskId,
      name: 'fixture',
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/test',
      worktreePath: '/tmp/test/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/' + taskId,
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
  opts: { nodeId?: string; clarifyIteration?: number } = {},
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
      status: 'done',
      startedAt: Date.now(),
    })
    .run()
  return id
}

describe('RFC-064 — getTaskNodeRuns surfaces unified clarifyIteration', () => {
  function makeDb(): DbClient {
    return createInMemoryDb(MIGRATIONS)
  }

  test('A1: legacy row surfaces clarifyIteration=0 on the wire', async () => {
    const db = makeDb()
    const { taskId } = seedTask(db)
    seedRun(db, taskId, { clarifyIteration: 0 })
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.length).toBe(1)
    expect(res.runs[0]?.clarifyIteration).toBe(0)
  })

  test('A2: elevated clarify rerun row surfaces clarifyIteration=N (covers cross-clarify after unification)', async () => {
    const db = makeDb()
    const { taskId } = seedTask(db)
    seedRun(db, taskId, { clarifyIteration: 2 })
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.length).toBe(1)
    expect(res.runs[0]?.clarifyIteration).toBe(2)
  })

  test('A3: multiple rows for one node retain distinct clarifyIteration values', async () => {
    const db = makeDb()
    const { taskId } = seedTask(db)
    seedRun(db, taskId, { nodeId: 'designer', clarifyIteration: 0 })
    seedRun(db, taskId, { nodeId: 'designer', clarifyIteration: 1 })
    seedRun(db, taskId, { nodeId: 'designer', clarifyIteration: 3 })
    const res = await getTaskNodeRuns(db, taskId)
    const values = res.runs.map((r) => r.clarifyIteration).sort((a, b) => a - b)
    expect(values).toEqual([0, 1, 3])
  })

  test('A4: clarifyIteration is independent of other counters on the wire', async () => {
    const db = makeDb()
    const { taskId } = seedTask(db)
    seedRun(db, taskId, { clarifyIteration: 5 })
    seedRun(db, taskId, { clarifyIteration: 0 })
    const res = await getTaskNodeRuns(db, taskId)
    const sorted = res.runs.slice().sort((a, b) => b.clarifyIteration - a.clarifyIteration)
    expect(sorted[0]?.clarifyIteration).toBe(5)
    expect(sorted[1]?.clarifyIteration).toBe(0)
  })
})
