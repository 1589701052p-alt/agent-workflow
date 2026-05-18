// RFC-036 PR4 — `ensureValidAssignments` pure validator + the launch-time
// transaction (recordLaunchContext). Together they prove the launcher 422
// path holds and that the happy path persists the right rows.

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { nodeAssignments, taskCollaborators, tasks, users, workflows } from '../src/db/schema'
import { createUser } from '../src/services/users'
import {
  changeNodeAssignment,
  ensureValidAssignments,
  recordLaunchContext,
} from '../src/services/taskCollab'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const wfDef = {
  nodes: [
    { id: 'agent-a', kind: 'agent-single' },
    { id: 'review-final', kind: 'review' },
    { id: 'clarify-q', kind: 'clarify' },
  ],
}

describe('ensureValidAssignments', () => {
  test('happy path: reviewer → review node + clarify_target → clarify node', () => {
    ensureValidAssignments(wfDef, [
      { nodeId: 'review-final', kind: 'reviewer', userId: 'u1' },
      { nodeId: 'clarify-q', kind: 'clarify_target', userId: 'u2' },
    ])
  })

  test('rejects unknown nodeId', () => {
    expect(() =>
      ensureValidAssignments(wfDef, [{ nodeId: 'no-such-node', kind: 'reviewer', userId: 'u1' }]),
    ).toThrow(/unknown nodeId/)
  })

  test('rejects kind/node-kind mismatch (reviewer on a clarify node)', () => {
    expect(() =>
      ensureValidAssignments(wfDef, [{ nodeId: 'clarify-q', kind: 'reviewer', userId: 'u1' }]),
    ).toThrow(/incompatible with node kind/)
  })

  test('rejects clarify_target on a non-clarify node', () => {
    expect(() =>
      ensureValidAssignments(wfDef, [{ nodeId: 'agent-a', kind: 'clarify_target', userId: 'u1' }]),
    ).toThrow(/incompatible with node kind/)
  })

  test('rejects duplicate (nodeId, kind) pair', () => {
    expect(() =>
      ensureValidAssignments(wfDef, [
        { nodeId: 'review-final', kind: 'reviewer', userId: 'u1' },
        { nodeId: 'review-final', kind: 'reviewer', userId: 'u2' },
      ]),
    ).toThrow(/duplicate assignment/)
  })

  test('empty array is always valid', () => {
    ensureValidAssignments(wfDef, [])
  })

  test('null workflow def → unknown-nodeId error (no crash)', () => {
    expect(() =>
      ensureValidAssignments(null, [{ nodeId: 'review-final', kind: 'reviewer', userId: 'u1' }]),
    ).toThrow(/unknown nodeId/)
  })
})

describe('recordLaunchContext + changeNodeAssignment', () => {
  let db: DbClient

  async function seedTask(id: string, ownerId: string) {
    const wfId = `wf-${id}`
    await db.insert(workflows).values({
      id: wfId,
      name: `wf-${id}`,
      description: '',
      definition: JSON.stringify(wfDef),
    })
    await db.insert(tasks).values({
      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: '/tmp/repo',
      repoUrl: null,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: null,
      status: 'done',
      inputs: '{}',
      maxDurationMs: null,
      maxTotalTokens: null,
      startedAt: 0,
      finishedAt: 0,
      errorSummary: null,
      errorMessage: null,
      failedNodeId: null,
      expiresAt: null,
      deletedAt: null,
      schemaVersion: 1,
      ownerUserId: ownerId,
    })
  }

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'dave',
      displayName: 'Dave',
      role: 'user',
      password: 'pw12345678',
    })
  })

  test('records owner + reviewer assignment + extra collaborator', async () => {
    const bob = (await db.select().from(users).where(eq(users.username, 'bob')))[0]!
    const carol = (await db.select().from(users).where(eq(users.username, 'carol')))[0]!
    const dave = (await db.select().from(users).where(eq(users.username, 'dave')))[0]!
    await seedTask('task-1', bob.id)

    await recordLaunchContext(db, {
      taskId: 'task-1',
      ownerUserId: bob.id,
      assignments: [{ nodeId: 'review-final', kind: 'reviewer', userId: carol.id }],
      collaboratorUserIds: [dave.id],
      now: 1_000,
    })

    const collabs = await db
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, 'task-1'))
    // owner (bob) + collaborator (dave) + reviewer (carol)
    expect(collabs.length).toBe(3)
    expect(collabs.find((r) => r.userId === bob.id)?.role).toBe('owner')
    expect(collabs.find((r) => r.userId === carol.id)?.role).toBe('reviewer')
    expect(collabs.find((r) => r.userId === dave.id)?.role).toBe('collaborator')

    const assigns = await db
      .select()
      .from(nodeAssignments)
      .where(eq(nodeAssignments.taskId, 'task-1'))
    expect(assigns.length).toBe(1)
    expect(assigns[0]?.userId).toBe(carol.id)
  })

  test('rejects when any referenced user is disabled', async () => {
    const bob = (await db.select().from(users).where(eq(users.username, 'bob')))[0]!
    const carol = (await db.select().from(users).where(eq(users.username, 'carol')))[0]!
    await seedTask('task-2', bob.id)
    await db.update(users).set({ status: 'disabled' }).where(eq(users.id, carol.id))
    await expect(
      recordLaunchContext(db, {
        taskId: 'task-2',
        ownerUserId: bob.id,
        assignments: [{ nodeId: 'review-final', kind: 'reviewer', userId: carol.id }],
        collaboratorUserIds: [],
        now: 1_000,
      }),
    ).rejects.toThrow(/not active/)
  })

  test('changeNodeAssignment updates existing row + mirrors to collaborators', async () => {
    const bob = (await db.select().from(users).where(eq(users.username, 'bob')))[0]!
    const carol = (await db.select().from(users).where(eq(users.username, 'carol')))[0]!
    const dave = (await db.select().from(users).where(eq(users.username, 'dave')))[0]!
    await seedTask('task-3', bob.id)
    await recordLaunchContext(db, {
      taskId: 'task-3',
      ownerUserId: bob.id,
      assignments: [{ nodeId: 'review-final', kind: 'reviewer', userId: carol.id }],
      collaboratorUserIds: [],
      now: 1_000,
    })
    await changeNodeAssignment(db, {
      taskId: 'task-3',
      nodeId: 'review-final',
      kind: 'reviewer',
      newUserId: dave.id,
      actorId: bob.id,
      now: 2_000,
    })
    const assigns = await db
      .select()
      .from(nodeAssignments)
      .where(eq(nodeAssignments.taskId, 'task-3'))
    expect(assigns[0]?.userId).toBe(dave.id)
    expect(assigns[0]?.assignedAt).toBe(2_000)
    const collabs = await db
      .select()
      .from(taskCollaborators)
      .where(eq(taskCollaborators.taskId, 'task-3'))
    expect(collabs.some((r) => r.userId === dave.id && r.role === 'reviewer')).toBe(true)
  })
})
