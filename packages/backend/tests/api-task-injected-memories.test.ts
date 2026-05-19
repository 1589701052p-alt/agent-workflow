// RFC-046 — locks the REST projection of node_runs.injected_memories_json
// into the wire-level `injectedMemories` field on NodeRun. Covers:
//   - Happy path: persisted JSON → parsed array in the response.
//   - Legacy row (NULL column) → field surfaces as null.
//   - Corrupted JSON in the column → field surfaces as null (no 5xx).
//   - Empty-array payload distinct from NULL.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { eq } from 'drizzle-orm'
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
      definition: JSON.stringify({ schemaVersion: 1, name: 'wf', nodes: [], edges: [] }),
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

function seedRun(db: DbClient, taskId: string, json: string | null, nodeId = 'n'): string {
  const id = ulid()
  db.insert(nodeRuns)
    .values({
      id,
      taskId,
      nodeId,
      iteration: 0,
      retryIndex: 0,
      reviewIteration: 0,
      clarifyIteration: 0,
      status: 'done',
      injectedMemoriesJson: json,
      startedAt: Date.now(),
    })
    .run()
  return id
}

describe('RFC-046 — getTaskNodeRuns surfaces injectedMemories', () => {
  let db: DbClient
  beforeEach(() => {
    resetBroadcastersForTests()
    db = createInMemoryDb(MIGRATIONS)
  })
  afterEach(() => {
    resetBroadcastersForTests()
  })

  test('A1: persisted snapshot JSON parses into an array on the wire', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const payload = JSON.stringify([
      {
        id: 'm1',
        version: 3,
        scopeType: 'agent',
        scopeId: 'a',
        title: 'Title',
        bodyMd: 'Body',
        tags: ['x', 'y'],
        sourceKind: 'review',
        approvedAt: 1_700_000_000_000,
      },
    ])
    seedRun(db, taskId, payload)
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs.length).toBe(1)
    const im = res.runs[0]!.injectedMemories
    expect(im).not.toBeNull()
    expect(im?.length).toBe(1)
    expect(im?.[0]?.id).toBe('m1')
    expect(im?.[0]?.version).toBe(3)
    expect(im?.[0]?.tags).toEqual(['x', 'y'])
    expect(im?.[0]?.sourceKind).toBe('review')
  })

  test('A2: legacy row with NULL column surfaces as injectedMemories=null', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, null)
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs[0]!.injectedMemories).toBeNull()
  })

  test('A3: corrupted JSON in column degrades to null (no 5xx)', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, '{not-an-array')
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs[0]!.injectedMemories).toBeNull()
  })

  test('A4: empty-array payload surfaces as [] (distinct from null)', async () => {
    const { taskId } = seedTaskAndWorkflow(db)
    seedRun(db, taskId, '[]')
    const res = await getTaskNodeRuns(db, taskId)
    expect(res.runs[0]!.injectedMemories).toEqual([])
  })
})
