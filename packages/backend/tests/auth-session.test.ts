// RFC-036 — three-track auth middleware integration.

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { Hono } from 'hono'
import { actorOf, SYSTEM_USER_ID } from '../src/auth/actor'
import { createPat } from '../src/auth/patStore'
import { multiAuth } from '../src/auth/session'
import { createSession } from '../src/auth/sessionStore'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { users } from '../src/db/schema'
import { errorHandler } from '../src/util/errors'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')
const DAEMON_TOKEN = 'a'.repeat(64)

function buildApp(db: DbClient): Hono {
  const app = new Hono()
  app.use('/api/*', multiAuth({ db, daemonToken: DAEMON_TOKEN }))
  app.get('/api/whoami', (c) => {
    const a = actorOf(c)
    return c.json({
      id: a.user.id,
      role: a.user.role,
      source: a.source,
      permissions: [...a.permissions],
    })
  })
  app.onError(errorHandler)
  return app
}

async function seedUser(db: DbClient, id: string, role: 'admin' | 'user' = 'user') {
  await db.insert(users).values({
    id,
    username: id.toLowerCase(),
    email: `${id.toLowerCase()}@example.com`,
    displayName: id,
    passwordHash: null,
    role,
    status: 'active',
    forcePasswordChange: 0,
    createdBy: null,
    createdAt: 0,
    updatedAt: 0,
    lastLoginAt: null,
    schemaVersion: 1,
  })
}

describe('multiAuth — daemon token track', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('valid daemon token resolves to __system__ admin actor', async () => {
    const app = buildApp(db)
    const res = await app.request('/api/whoami', {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; role: string; source: string }
    expect(body.id).toBe(SYSTEM_USER_ID)
    expect(body.role).toBe('admin')
    expect(body.source).toBe('daemon')
  })

  test('64-char hex but wrong token → 401', async () => {
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${'b'.repeat(64)}` },
    })
    expect(res.status).toBe(401)
  })

  test('arbitrary unrelated tokens → 401 (no leak of daemon token shape)', async () => {
    expect(
      (await buildApp(db).request('/api/whoami', { headers: { Authorization: 'Bearer xxx' } }))
        .status,
    ).toBe(401)
    expect(
      (
        await buildApp(db).request('/api/whoami', {
          headers: { Authorization: `Bearer ${'a'.repeat(63)}` },
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await buildApp(db).request('/api/whoami', {
          headers: { Authorization: `Bearer ${'a'.repeat(65)}` },
        })
      ).status,
    ).toBe(401)
  })
})

describe('multiAuth — session token track', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('valid session token → user actor with role permissions', async () => {
    await seedUser(db, '01HQALICE', 'admin')
    const { token } = await createSession({ db, userId: '01HQALICE' })
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { id: string; role: string; source: string }
    expect(body.id).toBe('01HQALICE')
    expect(body.role).toBe('admin')
    expect(body.source).toBe('session')
  })

  test('valid session token via ?token=', async () => {
    await seedUser(db, '01HQBOB')
    const { token } = await createSession({ db, userId: '01HQBOB' })
    const res = await buildApp(db).request(`/api/whoami?token=${token}`)
    expect(res.status).toBe(200)
  })

  test('mistyped session prefix is not interpreted as daemon token', async () => {
    // aws_s_<63 chars> -> not a known token; daemon token regex never matches
    // because of leading non-hex letters.
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer aws_s_${'a'.repeat(63)}` },
    })
    expect(res.status).toBe(401)
  })
})

describe('multiAuth — PAT track', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('PAT narrows permissions to the configured scopes', async () => {
    await seedUser(db, '01HQCAROL', 'user')
    const { token } = await createPat({
      db,
      userId: '01HQCAROL',
      name: 'ci',
      scopes: ['tasks:launch'],
    })
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      role: string
      source: string
      permissions: string[]
    }
    expect(body.id).toBe('01HQCAROL')
    expect(body.role).toBe('user')
    expect(body.source).toBe('pat')
    // PAT scopes are intersected with role baseline → only 'tasks:launch'
    // (because role='user' has tasks:launch in its baseline). No other.
    expect(body.permissions).toEqual(['tasks:launch'])
  })

  test('PAT cannot widen beyond role (admin-only scope on user PAT is dropped)', async () => {
    await seedUser(db, '01HQDAVE', 'user')
    const { token } = await createPat({
      db,
      userId: '01HQDAVE',
      name: 'overreach',
      scopes: ['agents:write', 'tasks:launch'],
    })
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const body = (await res.json()) as { permissions: string[] }
    expect(body.permissions.sort()).toEqual(['tasks:launch'])
  })
})

describe('multiAuth — no token / malformed header', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('missing Authorization → 401', async () => {
    const res = await buildApp(db).request('/api/whoami')
    expect(res.status).toBe(401)
  })

  test('Authorization without Bearer prefix → 401', async () => {
    const res = await buildApp(db).request('/api/whoami', {
      headers: { Authorization: DAEMON_TOKEN },
    })
    expect(res.status).toBe(401)
  })

  test('empty token query → 401', async () => {
    const res = await buildApp(db).request('/api/whoami?token=')
    expect(res.status).toBe(401)
  })
})
