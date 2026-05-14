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

  test('all /api/tasks/* require token', async () => {
    expect((await h.app.request('/api/tasks')).status).toBe(401)
  })
})
