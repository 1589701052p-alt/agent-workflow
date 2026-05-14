// Service + HTTP coverage for Workflow CRUD (P-1-11).
// In-memory SQLite; CRUD round-trips and references checks only — full
// topology/port validation lands in P-2-01.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks } from '../src/db/schema'
import { createApp } from '../src/server'
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  validateWorkflow,
} from '../src/services/workflow'
import { ConflictError, NotFoundError } from '../src/util/errors'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildHarness(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

function sampleDefinition(): WorkflowDefinition {
  return {
    $schema_version: 1,
    inputs: [{ kind: 'text', key: 'requirement', label: '需求', required: true, multiline: true }],
    nodes: [
      { id: 'in_1', kind: 'input', inputKey: 'requirement' },
      { id: 'worker', kind: 'agent-single', agentName: 'code-worker' },
    ],
    edges: [
      {
        id: 'e1',
        source: { nodeId: 'in_1', portName: 'out' },
        target: { nodeId: 'worker', portName: 'requirement' },
      },
    ],
  }
}

describe('workflow service', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('list empty -> []', async () => {
    expect(await listWorkflows(db)).toEqual([])
  })

  test('create stores definition + sets version=1', async () => {
    const wf = await createWorkflow(db, {
      name: 'my workflow',
      description: 'desc',
      definition: sampleDefinition(),
    })
    expect(wf.id).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/) // ULID
    expect(wf.name).toBe('my workflow')
    expect(wf.version).toBe(1)
    expect(wf.definition.nodes.length).toBe(2)
    expect(wf.definition.edges.length).toBe(1)
  })

  test('update bumps version + persists definition', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    const after = await updateWorkflow(db, wf.id, {
      name: 'renamed',
      definition: { ...sampleDefinition(), nodes: [] },
    })
    expect(after.version).toBe(2)
    expect(after.name).toBe('renamed')
    expect(after.definition.nodes.length).toBe(0)
  })

  test('update unknown id -> NotFoundError', async () => {
    await expect(
      updateWorkflow(db, '01HXXXXXXXXXXXXXXXXXXX', { name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete removes; unknown -> NotFoundError', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    await deleteWorkflow(db, wf.id)
    expect(await getWorkflow(db, wf.id)).toBeNull()
    await expect(deleteWorkflow(db, wf.id)).rejects.toBeInstanceOf(NotFoundError)
  })

  test('delete refuses when ANY task references the workflow (running)', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    await db.insert(tasks).values({
      id: ulid(),
      workflowId: wf.id,
      workflowSnapshot: JSON.stringify(wf.definition),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/T',
      status: 'running',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await expect(deleteWorkflow(db, wf.id)).rejects.toBeInstanceOf(ConflictError)
  })

  test('delete refuses when ANY task references the workflow (done)', async () => {
    // Per design Q&A round 18: any reference (regardless of status) blocks
    // deletion. Future relaxation tracked in STATE.md tech debt.
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    await db.insert(tasks).values({
      id: ulid(),
      workflowId: wf.id,
      workflowSnapshot: JSON.stringify(wf.definition),
      repoPath: '/tmp/repo',
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: 'agent-workflow/T',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now(),
    })
    await expect(deleteWorkflow(db, wf.id)).rejects.toBeInstanceOf(ConflictError)
  })

  test('validate stub returns { ok:true, issues:[] }', async () => {
    const wf = await createWorkflow(db, {
      name: 'wf',
      description: '',
      definition: sampleDefinition(),
    })
    const result = await validateWorkflow(db, wf.id)
    expect(result).toEqual({ ok: true, issues: [] })
  })
})

describe('workflow HTTP routes', () => {
  let app: Hono

  beforeEach(() => {
    ;({ app } = buildHarness())
  })

  test('POST creates workflow + GET roundtrips', async () => {
    const post = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wf1',
        description: 'd',
        definition: sampleDefinition(),
      }),
    })
    expect(post.status).toBe(201)
    const created = (await post.json()) as { id: string; version: number }
    expect(created.version).toBe(1)

    const got = await req(app, `/api/workflows/${created.id}`)
    expect(got.status).toBe(200)
  })

  test('invalid payload returns 422 with workflow-invalid code', async () => {
    const res = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: '', description: '', definition: sampleDefinition() }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-invalid')
  })

  test('missing $schema_version in definition rejected', async () => {
    const res = await req(app, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({
        name: 'wf',
        description: '',
        definition: { nodes: [], edges: [], inputs: [] },
      }),
    })
    expect(res.status).toBe(422)
  })

  test('PUT updates fields and increments version', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'wf',
          description: '',
          definition: sampleDefinition(),
        }),
      })
    ).json()) as { id: string }

    const put = await req(app, `/api/workflows/${created.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name: 'renamed' }),
    })
    expect(put.status).toBe(200)
    const after = (await put.json()) as { name: string; version: number }
    expect(after.name).toBe('renamed')
    expect(after.version).toBe(2)
  })

  test('GET unknown id returns 404 with workflow-not-found', async () => {
    const res = await req(app, '/api/workflows/01HFAKEFAKEFAKEFAKEFAKE')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-not-found')
  })

  test('DELETE 204; double DELETE 404', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'wf',
          description: '',
          definition: sampleDefinition(),
        }),
      })
    ).json()) as { id: string }
    const del = await req(app, `/api/workflows/${created.id}`, { method: 'DELETE' })
    expect(del.status).toBe(204)
    const again = await req(app, `/api/workflows/${created.id}`, { method: 'DELETE' })
    expect(again.status).toBe(404)
  })

  test('POST /:id/validate returns stub response', async () => {
    const created = (await (
      await req(app, '/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          name: 'wf',
          description: '',
          definition: sampleDefinition(),
        }),
      })
    ).json()) as { id: string }
    const res = await req(app, `/api/workflows/${created.id}/validate`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, issues: [] })
  })

  test('all /api/workflows/* require token', async () => {
    expect((await app.request('/api/workflows')).status).toBe(401)
  })
})
