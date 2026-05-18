// RFC-036 — /api/auth/login + /me + /change-password + sessions + PATs + identities.

import { beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { Hono } from 'hono'
import { createSecretBoxFromKey } from '../src/auth/secretBox'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import { createUser } from '../src/services/users'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  app: Hono
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const secretBox = createSecretBoxFromKey(randomBytes(32))
  const app = createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
    secretBox,
  })
  return { db, app }
}

async function reqRaw(
  app: Hono,
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  const h = new Headers(init.headers)
  for (const [k, v] of Object.entries(headers)) h.set(k, v)
  if (init.body && !h.has('content-type')) h.set('content-type', 'application/json')
  return app.request(path, { ...init, headers: h })
}

describe('POST /api/auth/login', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
    await createUser(h.db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'correctPassword123',
    })
  })

  test('happy path returns sessionToken + user', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'correctPassword123' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sessionToken: string; user: { username: string } }
    expect(body.sessionToken.startsWith('aws_s_')).toBe(true)
    expect(body.user.username).toBe('alice')
  })

  test('wrong password → 401 (constant-time response)', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'wrong-pw' }),
    })
    expect(res.status).toBe(401)
  })

  test('unknown user → 401 (no leakage)', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'ghost', password: 'irrelevant' }),
    })
    expect(res.status).toBe(401)
  })

  test('invalid body → 422', async () => {
    const res = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: '' }),
    })
    expect(res.status).toBe(422)
  })
})

describe('/api/auth/me', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })

  test('returns the resolved actor + linked identities + pats (admin via daemon token)', async () => {
    const res = await reqRaw(h.app, '/api/auth/me', {}, { Authorization: `Bearer ${DAEMON_TOKEN}` })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { id: string }
      source: string
      linkedIdentities: unknown[]
      pats: unknown[]
    }
    expect(body.source).toBe('daemon')
    expect(Array.isArray(body.linkedIdentities)).toBe(true)
    expect(Array.isArray(body.pats)).toBe(true)
  })
})

describe('Change-password round-trip', () => {
  test('user can change password + revoke other sessions', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'oldOldOldOld',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'oldOldOldOld' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const change = await reqRaw(
      h.app,
      '/api/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ oldPassword: 'oldOldOldOld', newPassword: 'newNewNewNew' }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(change.status).toBe(200)
    const body = (await change.json()) as { sessionToken: string }
    expect(body.sessionToken.startsWith('aws_s_')).toBe(true)
    // Old session is now revoked
    const me = await reqRaw(h.app, '/api/auth/me', {}, { Authorization: `Bearer ${sessionToken}` })
    expect(me.status).toBe(401)
    // New session works
    const me2 = await reqRaw(
      h.app,
      '/api/auth/me',
      {},
      { Authorization: `Bearer ${body.sessionToken}` },
    )
    expect(me2.status).toBe(200)
  })

  test('wrong old password → 403', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'goodGoodGood',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'goodGoodGood' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const change = await reqRaw(
      h.app,
      '/api/auth/change-password',
      {
        method: 'POST',
        body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'newNewNewNew' }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(change.status).toBe(403)
  })
})

describe('PATs', () => {
  test('create + list + revoke flow', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'pw12345678' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }

    const created = await reqRaw(
      h.app,
      '/api/auth/pats',
      { method: 'POST', body: JSON.stringify({ name: 'ci-launcher', scopes: ['tasks:launch'] }) },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(created.status).toBe(201)
    const { token, id } = (await created.json()) as { token: string; id: string }
    expect(token.startsWith('aws_pat_')).toBe(true)

    const list = await reqRaw(
      h.app,
      '/api/auth/pats',
      {},
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(list.status).toBe(200)
    expect(((await list.json()) as unknown[]).length).toBe(1)

    const del = await reqRaw(
      h.app,
      `/api/auth/pats/${id}`,
      { method: 'DELETE' },
      { Authorization: `Bearer ${sessionToken}` },
    )
    expect(del.status).toBe(204)
    // After revoke, PAT token cannot be used.
    const auth = await reqRaw(h.app, '/api/auth/me', {}, { Authorization: `Bearer ${token}` })
    expect(auth.status).toBe(401)
  })

  test('PAT scopes that the user does not have are silently dropped', async () => {
    const h = await buildHarness()
    await createUser(h.db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    const login = await reqRaw(h.app, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'pw12345678' }),
    })
    const { sessionToken } = (await login.json()) as { sessionToken: string }
    const created = await reqRaw(
      h.app,
      '/api/auth/pats',
      {
        method: 'POST',
        body: JSON.stringify({ name: 'overreach', scopes: ['agents:write', 'tasks:launch'] }),
      },
      { Authorization: `Bearer ${sessionToken}` },
    )
    const body = (await created.json()) as { scopes: string[] }
    expect(body.scopes).toEqual(['tasks:launch'])
  })
})
