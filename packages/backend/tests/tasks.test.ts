// HTTP coverage for /api/tasks (P-1-14).
// Uses a real `git init` fixture so startTask's worktree creation works.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'
import { runGit } from '../src/util/git'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  repoPath: string
  appHome: string
  cleanup: () => void
}

async function buildHarness(): Promise<Harness> {
  const appHome = mkdtempSync(join(tmpdir(), 'aw-tasks-'))
  const repoPath = mkdtempSync(join(tmpdir(), 'aw-tasks-repo-'))
  // Tests reuse Paths.root for worktrees / runs; route handlers read it lazily.
  const prevHome = process.env.AGENT_WORKFLOW_HOME
  process.env.AGENT_WORKFLOW_HOME = appHome
  await runGit(repoPath, ['init', '-q', '-b', 'main'])
  await runGit(repoPath, ['config', 'user.email', 'test@example.com'])
  await runGit(repoPath, ['config', 'user.name', 'Test'])
  writeFileSync(join(repoPath, 'README.md'), '# repo\n')
  await runGit(repoPath, ['add', '.'])
  await runGit(repoPath, ['commit', '-q', '-m', 'init'])

  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: join(appHome, 'config.json'),
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return {
    db,
    app,
    repoPath,
    appHome,
    cleanup: () => {
      rmSync(appHome, { recursive: true, force: true })
      rmSync(repoPath, { recursive: true, force: true })
      if (prevHome === undefined) delete process.env.AGENT_WORKFLOW_HOME
      else process.env.AGENT_WORKFLOW_HOME = prevHome
    },
  }
}

async function req(app: Hono, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${TOKEN}`)
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
  return app.request(path, { ...init, headers })
}

async function seedWorkflow(db: DbClient, def: WorkflowDefinition): Promise<string> {
  const id = ulid()
  await db.insert(workflows).values({
    id,
    name: 'wf',
    definition: JSON.stringify(def),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return id
}

const EMPTY_DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [],
}

describe('task HTTP routes', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(() => h.cleanup())

  test('POST creates task with status=pending (scheduler still running in background)', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    expect(res.status).toBe(201)
    const task = (await res.json()) as { id: string; status: string; branch: string }
    expect(typeof task.id).toBe('string')
    expect(['pending', 'running', 'done']).toContain(task.status)
    expect(task.branch).toBe(`agent-workflow/${task.id}`)
  })

  test('POST with unknown workflow id -> 404', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: '01HFAKE',
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('workflow-not-found')
  })

  test('POST with non-git repo path creates a task with status=failed', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const notRepo = mkdtempSync(join(tmpdir(), 'aw-notrepo-'))
    try {
      const res = await req(h.app, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          workflowId: wfId,
          repoPath: notRepo,
          baseBranch: 'main',
          inputs: {},
        }),
      })
      expect(res.status).toBe(201)
      const task = (await res.json()) as { status: string; errorSummary: string | null }
      expect(task.status).toBe('failed')
      expect(task.errorSummary).toContain('worktree creation failed')
    } finally {
      rmSync(notRepo, { recursive: true, force: true })
    }
  })

  test('GET /:id roundtrips; GET / lists; status filter narrows', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    // Create three tasks; vary status by direct insert (POST always starts as
    // pending/running so we can't observe filtering on POST alone).
    await h.db.insert(tasks).values({
      id: ulid(),
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt-a',
      baseBranch: 'main',
      branch: 'agent-workflow/A',
      status: 'done',
      inputs: '{}',
      startedAt: Date.now() - 3000,
      finishedAt: Date.now() - 1000,
    })
    await h.db.insert(tasks).values({
      id: ulid(),
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt-b',
      baseBranch: 'main',
      branch: 'agent-workflow/B',
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now() - 2000,
      finishedAt: Date.now(),
    })

    const list = (await (await req(h.app, '/api/tasks')).json()) as Array<{ status: string }>
    expect(list.length).toBeGreaterThanOrEqual(2)

    const done = (await (await req(h.app, '/api/tasks?status=done')).json()) as Array<{
      status: string
    }>
    expect(done.every((t) => t.status === 'done')).toBe(true)
    expect(done.length).toBeGreaterThanOrEqual(1)
  })

  test('GET /api/tasks/:id unknown returns 404', async () => {
    const res = await req(h.app, '/api/tasks/01HFAKEFAKE')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { code: string }).code).toBe('task-not-found')
  })

  test('POST invalid body returns 422', async () => {
    const res = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ workflowId: '', repoPath: '', baseBranch: '', inputs: {} }),
    })
    expect(res.status).toBe(422)
    expect(((await res.json()) as { code: string }).code).toBe('task-invalid')
  })

  test('POST /:id/cancel on a completed task -> 409 task-not-cancelable', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'done',
      inputs: '{}',
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-not-cancelable')
  })

  test('POST /:id/cancel on an unknown task -> 404', async () => {
    const res = await req(h.app, '/api/tasks/01HFAKEFAKE/cancel', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('POST /:id/cancel on a stuck-running task (no active controller) flips to canceled', async () => {
    // Simulate a row left in 'running' state without an in-process controller
    // (e.g. after daemon restart). The cancel endpoint should still mark it
    // canceled rather than block forever.
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/wt',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      status: 'running',
      inputs: '{}',
      startedAt: Date.now() - 1000,
    })
    const res = await req(h.app, `/api/tasks/${id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(200)
    const task = (await res.json()) as { status: string; errorSummary: string }
    expect(task.status).toBe('canceled')
    expect(task.errorSummary).toContain('canceled')
  })

  test('all /api/tasks/* require token', async () => {
    expect((await h.app.request('/api/tasks')).status).toBe(401)
  })

  test('GET /:id/node-runs returns empty for a freshly-started task', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const post = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    const { id } = (await post.json()) as { id: string }
    const res = await req(h.app, `/api/tasks/${id}/node-runs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { runs: unknown[]; outputs: unknown[] }
    expect(Array.isArray(body.runs)).toBe(true)
    expect(Array.isArray(body.outputs)).toBe(true)
    // Empty workflow → scheduler may have inserted 0 runs by the time we
    // check; either way the shape is valid.
    expect(body.outputs.length).toBe(0)
  })

  test('GET /:id/node-runs on unknown task -> 404', async () => {
    const res = await req(h.app, '/api/tasks/01HFAKEFAKE/node-runs')
    expect(res.status).toBe(404)
  })

  test('GET /:id/diff returns the worktree diff vs baseCommit', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const post = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    const { id, worktreePath } = (await post.json()) as {
      id: string
      worktreePath: string
    }

    // Modify a tracked file in the worktree to produce a real diff.
    writeFileSync(join(worktreePath, 'README.md'), '# changed\n')

    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      diff: string
      baseCommit: string | null
      truncated: boolean
    }
    expect(body.baseCommit).toMatch(/^[a-f0-9]{40}$/)
    expect(body.truncated).toBe(false)
    expect(body.diff).toContain('README.md')
    expect(body.diff).toContain('# changed')
  })

  test('GET /:id/diff includes untracked files', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const post = await req(h.app, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        workflowId: wfId,
        repoPath: h.repoPath,
        baseBranch: 'main',
        inputs: {},
      }),
    })
    const { id, worktreePath } = (await post.json()) as { id: string; worktreePath: string }
    writeFileSync(join(worktreePath, 'NEWFILE.md'), 'fresh\n')

    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { diff: string }
    expect(body.diff).toContain('NEWFILE.md')
    expect(body.diff).toContain('fresh')
  })

  test('GET /:id/diff on a task without baseCommit -> 409', async () => {
    // Simulate the early-error path where startTask couldn't even create the
    // worktree (repo missing, base ref invalid, etc.).
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '',
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: null,
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(409)
    expect(((await res.json()) as { code: string }).code).toBe('task-no-base-commit')
  })

  test('GET /:id/diff when worktree dir is missing -> 410', async () => {
    const wfId = await seedWorkflow(h.db, EMPTY_DEF)
    const id = ulid()
    await h.db.insert(tasks).values({
      id,
      workflowId: wfId,
      workflowSnapshot: '{}',
      repoPath: h.repoPath,
      worktreePath: '/tmp/aw-nope-' + id,
      baseBranch: 'main',
      branch: `agent-workflow/${id}`,
      baseCommit: 'deadbeef'.repeat(5),
      status: 'failed',
      inputs: '{}',
      startedAt: Date.now(),
    })
    const res = await req(h.app, `/api/tasks/${id}/diff`)
    expect(res.status).toBe(410)
    expect(((await res.json()) as { code: string }).code).toBe('task-worktree-missing')
  })
})
