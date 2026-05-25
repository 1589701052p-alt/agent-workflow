// RFC-065 T3 — HTTP coverage for the two new worktree-files endpoints.
//
// Seeds a real on-disk worktree (tmpdir) into a tasks row so the routes can
// stat the filesystem; sanity-checks the JSON wire shape against the shared
// zod schemas to catch field drift between server / shared / client.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Hono } from 'hono'
import { ulid } from 'ulid'

import { worktreeFileResponseSchema, worktreeTreeResponseSchema } from '@agent-workflow/shared'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { tasks, workflows } from '../src/db/schema'
import { createApp } from '../src/server'

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

function buildApp(): { db: DbClient; app: Hono } {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  return { db, app }
}

async function req(app: Hono, path: string): Promise<Response> {
  return await app.request(path, { headers: { Authorization: `Bearer ${TOKEN}` } })
}

async function seedTask(
  db: DbClient,
  opts: { worktreePath: string; taskId?: string },
): Promise<string> {
  const taskId = opts.taskId ?? `task_${ulid()}`
  const workflowId = `wf_${taskId}`
  await db.insert(workflows).values({
    id: workflowId,
    name: 'wf',
    description: '',
    definition: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[],"outputs":[]}',
    version: 1,
    schemaVersion: 4,
  })
  await db.insert(tasks).values({
    id: taskId,
    name: 'rfc065-fixture',
    workflowId,
    workflowSnapshot: '{"$schema_version":4,"inputs":[],"nodes":[],"edges":[],"outputs":[]}',
    repoPath: '/tmp/aw-rfc065-routes-test',
    worktreePath: opts.worktreePath,
    baseBranch: 'main',
    branch: `agent-workflow/${taskId}`,
    status: 'done',
    inputs: '{}',
    startedAt: Date.now(),
  })
  return taskId
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rfc065-routes-'))
  // Seed a tiny tree to list/read against.
  await mkdir(join(root, 'src'))
  await writeFile(join(root, 'src', 'hello.ts'), 'console.log("hi")\n')
  await writeFile(join(root, 'README.md'), '# title\n')
  await mkdir(join(root, '.git'))
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('GET /api/tasks/:id/worktree-tree', () => {
  test('200 lists root, hides .git, sorts directory-first', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-tree?path=`)
    expect(res.status).toBe(200)
    const body = worktreeTreeResponseSchema.parse(await res.json())
    expect(body.path).toBe('')
    expect(body.truncated).toBe(false)
    expect(body.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
      'directory:src',
      'file:README.md',
    ])
  })

  test('200 lazy-loads subdir', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-tree?path=src`)
    expect(res.status).toBe(200)
    const body = worktreeTreeResponseSchema.parse(await res.json())
    expect(body.entries).toEqual([{ name: 'hello.ts', kind: 'file', size: 18 }])
  })

  test('422 on path traversal (..)', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-tree?path=../etc`)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('worktree-path-traversal')
  })

  test('404 when task does not exist', async () => {
    const { app } = buildApp()
    const res = await req(app, '/api/tasks/task_missing/worktree-tree?path=')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-not-found')
  })

  test('404 when task row exists but worktreePath is empty', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: '' })
    const res = await req(app, `/api/tasks/${taskId}/worktree-tree?path=`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('task-worktree-missing')
  })

  test('404 when listed directory does not exist', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-tree?path=does/not/exist`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('worktree-dir-not-found')
  })
})

describe('GET /api/tasks/:id/worktree-file', () => {
  test('200 returns content for small file', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-file?path=README.md`)
    expect(res.status).toBe(200)
    const body = worktreeFileResponseSchema.parse(await res.json())
    expect(body).toEqual({
      path: 'README.md',
      size: 8,
      oversized: false,
      content: '# title\n',
    })
  })

  test('200 oversized:true when file > 2 MiB', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const big = Buffer.alloc(2 * 1024 * 1024 + 100, 0x42)
    await writeFile(join(root, 'big.bin'), big)
    const res = await req(app, `/api/tasks/${taskId}/worktree-file?path=big.bin`)
    expect(res.status).toBe(200)
    const body = worktreeFileResponseSchema.parse(await res.json())
    expect(body.oversized).toBe(true)
    expect(body.content).toBe('')
    expect(body.size).toBe(big.length)
  })

  test('422 on empty path query', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-file?path=`)
    expect(res.status).toBe(422)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('worktree-file-missing-path')
  })

  test('404 on missing file', async () => {
    const { db, app } = buildApp()
    const taskId = await seedTask(db, { worktreePath: root })
    const res = await req(app, `/api/tasks/${taskId}/worktree-file?path=ghost.txt`)
    expect(res.status).toBe(404)
    const body = (await res.json()) as { code: string }
    expect(body.code).toBe('worktree-file-not-found')
  })
})
