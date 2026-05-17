// RFC-036 — admin-only endpoint gate. Seeds a regular-user session token and
// verifies every admin-only path returns 403, while public-fields endpoints
// (users:search) + homepage-runtime probe stay 200 for the same user.
//
// This is the most load-bearing PR2 test: it pins the negative set so future
// retrofits cannot accidentally widen the permission map.

import { beforeEach, describe, expect, test } from 'bun:test'
import type { Hono } from 'hono'
import { resolve } from 'node:path'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
  userToken: string
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const bob = await createUser(db, {
    username: 'bob',
    displayName: 'Bob',
    role: 'user',
    password: 'longEnoughPassword',
  })
  const { token } = await createSession({ db, userId: bob.id })
  return { db, app, userToken: token }
}

async function reqAs(
  app: Hono,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
  return app.request(path, { ...init, headers })
}

describe('regular-user session token — admin-only endpoints all return 403', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })

  test('GET /api/config → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/config')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { code: string; details?: Record<string, unknown> }
    expect(body.code).toBe('forbidden')
    expect(body.details?.requiredPermission).toBe('settings:read')
  })

  test('PUT /api/config → 403 (settings:write)', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/config', {
      method: 'PUT',
      body: JSON.stringify({ defaultModel: 'x' }),
    })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { details?: Record<string, unknown> }
    expect(body.details?.requiredPermission).toBe('settings:write')
  })

  test('POST /api/agents → 403 (agents:write)', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('PUT /api/agents/:name → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/agents/something', {
      method: 'PUT',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('DELETE /api/agents/:name → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/agents/something', { method: 'DELETE' })
    expect(res.status).toBe(403)
  })

  test('POST /api/skills → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/skills', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/mcps → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/mcps', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/plugins → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/plugins', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/workflows → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/workflows', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/repos → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/repos', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/cached-repos → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/cached-repos', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })

  test('POST /api/backup → 403', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/backup', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

describe('regular-user session token — endpoints that are intentionally open', () => {
  let h: Harness

  beforeEach(async () => {
    h = await buildHarness()
  })

  test('GET /api/agents (read) → 200', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/agents')
    expect(res.status).toBe(200)
  })

  test('GET /api/workflows (read) → 200', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/workflows')
    expect(res.status).toBe(200)
  })

  test('GET /api/runtime/opencode (homepage runtime dot) → 200', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/runtime/opencode')
    expect(res.status).toBe(200)
  })

  test('GET /api/whoami → 200 returns user payload', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/whoami')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { user: { username: string; role: string } }
    expect(body.user.username).toBe('bob')
    expect(body.user.role).toBe('user')
  })

  test('GET /api/tasks (default scope=mine) → 200 with empty list', async () => {
    const res = await reqAs(h.app, h.userToken, '/api/tasks')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe('PAT-bearing actor cannot escape role limits', () => {
  test('PAT carrying agents:write but issued for a regular user is still 403', async () => {
    const { db, app } = await buildHarness()
    const { createPat } = await import('../src/auth/patStore')
    const { findByUsername } = await import('../src/services/users')
    const bob = await findByUsername(db, 'bob')
    const { token } = await createPat({
      db,
      userId: bob!.id,
      name: 'overreach',
      scopes: ['agents:write'],
    })
    const res = await reqAs(app, token, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(403)
  })
})
