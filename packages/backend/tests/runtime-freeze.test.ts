// RFC-111 D15 — resolveFrozenRuntime: a node_run's runtime is resolved ONCE at
// first dispatch and frozen onto node_runs.runtime; resume/retry of the same row
// read the frozen value so a mutated agent.runtime / config.defaultRuntime can't
// re-route a captured session to the wrong runtime (Codex P1-2).

import { describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { resolveFrozenRuntime } from '../src/services/nodeRunMint'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedRun(): Promise<{ db: ReturnType<typeof createInMemoryDb>; id: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  const workflowId = ulid()
  const taskId = ulid()
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    definition: '{}',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId,
    workflowSnapshot: '{}',
    repoPath: '/r',
    worktreePath: '/w',
    baseBranch: 'main',
    branch: 'b',
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const id = ulid()
  await db.insert(nodeRuns).values({ id, taskId, nodeId: 'n1', status: 'pending' })
  return { db, id }
}

async function rowRuntime(db: ReturnType<typeof createInMemoryDb>, id: string): Promise<unknown> {
  return (
    await db.select({ runtime: nodeRuns.runtime }).from(nodeRuns).where(eq(nodeRuns.id, id))
  )[0]?.runtime
}

describe('resolveFrozenRuntime (RFC-111 D15)', () => {
  test('first dispatch resolves from agent.runtime and freezes it onto the row', async () => {
    const { db, id } = await seedRun()
    expect(await rowRuntime(db, id)).toBeNull()
    const r = await resolveFrozenRuntime(db, id, 'claude-code', undefined)
    expect(r).toBe('claude-code')
    expect(await rowRuntime(db, id)).toBe('claude-code') // frozen
  })

  test('resume reads the frozen value even after agent.runtime changes (P1-2)', async () => {
    const { db, id } = await seedRun()
    await resolveFrozenRuntime(db, id, 'claude-code', undefined) // freeze claude
    // agent later flipped to opencode — resume of the SAME row must NOT re-route.
    const r = await resolveFrozenRuntime(db, id, 'opencode', 'opencode')
    expect(r).toBe('claude-code')
    expect(await rowRuntime(db, id)).toBe('claude-code')
  })

  test('first dispatch falls back to config.defaultRuntime, then opencode', async () => {
    const a = await seedRun()
    expect(await resolveFrozenRuntime(a.db, a.id, null, 'claude-code')).toBe('claude-code')

    const b = await seedRun()
    expect(await resolveFrozenRuntime(b.db, b.id, null, null)).toBe('opencode')
    expect(await rowRuntime(b.db, b.id)).toBe('opencode')
  })

  test('an unrecognized frozen value is read as opencode (legacy NULL safety)', async () => {
    const { db, id } = await seedRun()
    await db.update(nodeRuns).set({ runtime: 'bogus-runtime' }).where(eq(nodeRuns.id, id))
    // bogus is not a valid kind → re-resolve from agent/default (here opencode)
    const r = await resolveFrozenRuntime(db, id, null, null)
    expect(r).toBe('opencode')
  })
})
