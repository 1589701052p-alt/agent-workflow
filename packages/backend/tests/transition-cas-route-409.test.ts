// RFC-053 PR-B integration boundary — ConcurrentNodeRunTransition (CAS
// race in `transitionNodeRunStatus`) and IllegalNodeRunTransition
// (legality check in `nextNodeRunStatus`) thrown inside a Hono handler
// must propagate to the shared errorHandler as HTTP 409 / 422 with the
// structured payload `{ code, message }`.
//
// PR-B's `tests/lifecycle-cas-race.test.ts` covers the type-level
// shape (err.status === 409 + err.code). This file covers the routing
// boundary (errorHandler doesn't double-wrap / smother / mistype the
// response).

import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import { nodeRuns, tasks, workflows } from '../src/db/schema'
import { ConcurrentNodeRunTransition, transitionNodeRunStatus } from '../src/services/lifecycle'
import { errorHandler } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedNodeRun(
  status:
    | 'pending'
    | 'running'
    | 'done'
    | 'awaiting_review'
    | 'awaiting_human'
    | 'failed'
    | 'canceled'
    | 'interrupted',
): Promise<{ db: ReturnType<typeof createInMemoryDb>; nodeRunId: string }> {
  const db = createInMemoryDb(MIGRATIONS)
  await db.insert(workflows).values({ id: 'w', name: 'w', definition: '{}' })
  const taskId = ulid()
  await db.insert(tasks).values({
    id: taskId,
    name: 't',
    workflowId: 'w',
    workflowSnapshot: '{}',
    repoPath: '/tmp',
    worktreePath: '/tmp',
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'running',
    inputs: '{}',
    startedAt: Date.now(),
  })
  const nodeRunId = ulid()
  await db.insert(nodeRuns).values({
    id: nodeRunId,
    taskId,
    nodeId: 'n',
    iteration: 0,
    retryIndex: 0,
    reviewIteration: 0,
    clarifyIteration: 0,
    status,
    startedAt: status === 'pending' ? null : Date.now(),
  })
  return { db, nodeRunId }
}

describe('RFC-053 — IllegalNodeRunTransition in a route → HTTP 422 + structured code', () => {
  test('approve-review on a `running` row → 422 illegal-node-run-transition', async () => {
    const { db, nodeRunId } = await seedNodeRun('running')
    const app = new Hono()
    app.onError(errorHandler)
    app.post('/test/approve/:id', async (c) => {
      const id = c.req.param('id')
      await transitionNodeRunStatus({
        db,
        nodeRunId: id,
        event: { kind: 'approve-review' }, // only legal from awaiting_review
      })
      return c.json({ ok: true })
    })
    const r = await app.request(`/test/approve/${nodeRunId}`, { method: 'POST' })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { ok: false; code: string; message: string }
    expect(body.code).toBe('illegal-node-run-transition')
    expect(body.message).toMatch(/approve-review/)
  })

  test('mark-running on a terminal `done` row → 422', async () => {
    const { db, nodeRunId } = await seedNodeRun('done')
    const app = new Hono()
    app.onError(errorHandler)
    app.post('/test/start/:id', async (c) => {
      const id = c.req.param('id')
      await transitionNodeRunStatus({
        db,
        nodeRunId: id,
        event: { kind: 'mark-running' },
        extra: { startedAt: Date.now() },
      })
      return c.json({ ok: true })
    })
    const r = await app.request(`/test/start/${nodeRunId}`, { method: 'POST' })
    expect(r.status).toBe(422)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('illegal-node-run-transition')
  })
})

describe('RFC-053 — ConcurrentNodeRunTransition in a route → HTTP 409 + structured code', () => {
  test('directly thrown from a handler → errorHandler maps to 409', async () => {
    const app = new Hono()
    app.onError(errorHandler)
    app.post('/test/race/:id', () => {
      throw new ConcurrentNodeRunTransition('nr1', 'pending', 'mark-running')
    })
    const r = await app.request('/test/race/nr1', { method: 'POST' })
    expect(r.status).toBe(409)
    const body = (await r.json()) as { ok: false; code: string; message: string }
    expect(body.code).toBe('concurrent-node-run-transition')
    expect(body.message).toMatch(/changed concurrently/)
  })

  test('NotFoundError from missing nodeRunId → 404 node-run-not-found', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const app = new Hono()
    app.onError(errorHandler)
    app.post('/test/missing/:id', async (c) => {
      const id = c.req.param('id')
      await transitionNodeRunStatus({
        db,
        nodeRunId: id,
        event: { kind: 'mark-running' },
      })
      return c.json({ ok: true })
    })
    const r = await app.request('/test/missing/does-not-exist', { method: 'POST' })
    expect(r.status).toBe(404)
    const body = (await r.json()) as { code: string }
    expect(body.code).toBe('node-run-not-found')
  })
})
