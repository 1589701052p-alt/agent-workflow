// RFC-046 — locks migration 0025: node_runs gains a nullable
// `injected_memories_json` column. Legacy rows (pre-RFC-046, inserted
// without the field) come back with injectedMemoriesJson == NULL. New
// rows can write and read the JSON payload round-trip.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { eq } from 'drizzle-orm'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'

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
      name: 'fixture-task',
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

describe('migration 0025 (RFC-046 node_runs.injected_memories_json)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('M1: column stores JSON and is null when omitted', () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const withJson = ulid()
    const legacy = ulid()
    const payload = JSON.stringify([
      {
        id: 'mem_01',
        version: 1,
        scopeType: 'agent',
        scopeId: 'agent_xyz',
        title: 't',
        bodyMd: 'b',
        tags: ['x'],
        sourceKind: 'review',
        approvedAt: 1_700_000_000_000,
      },
    ])

    db.insert(nodeRuns)
      .values({
        id: withJson,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
        injectedMemoriesJson: payload,
      })
      .run()

    db.insert(nodeRuns)
      .values({
        id: legacy,
        taskId,
        nodeId: 'agent-2',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
        // injectedMemoriesJson intentionally omitted — legacy row
      })
      .run()

    const rows = db.select().from(nodeRuns).all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(withJson)?.injectedMemoriesJson).toBe(payload)
    expect(byId.get(legacy)?.injectedMemoriesJson).toBeNull()
  })

  test('M2: empty-array payload round-trips (distinct from NULL)', () => {
    const { taskId } = seedTaskAndWorkflow(db)
    const id = ulid()
    db.insert(nodeRuns)
      .values({
        id,
        taskId,
        nodeId: 'agent-1',
        iteration: 0,
        retryIndex: 0,
        reviewIteration: 0,
        status: 'done',
        injectedMemoriesJson: '[]',
      })
      .run()
    const row = db.select().from(nodeRuns).where(eq(nodeRuns.id, id)).get()
    expect(row?.injectedMemoriesJson).toBe('[]')
  })
})
