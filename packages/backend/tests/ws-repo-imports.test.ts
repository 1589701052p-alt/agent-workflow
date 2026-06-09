// RFC-033-T3: /ws/repo-imports/{batchId} channel.

import type { Server } from 'bun'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { createApp } from '../src/server'
import {
  REPO_IMPORT_CHANNEL,
  repoImportsBroadcaster,
  resetBroadcastersForTests,
} from '../src/ws/broadcaster'
import { buildWebSocketAdapter } from '../src/ws/server'

type AnyServer = Server<unknown>

const TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface Harness {
  db: DbClient
  server: AnyServer
  url: string
  cleanup: () => Promise<void>
}

async function buildHarness(): Promise<Harness> {
  const db = createInMemoryDb(MIGRATIONS)
  const app = createApp({
    token: TOKEN,
    configPath: '/tmp/__never_used__.json',
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db,
  })
  const ws = buildWebSocketAdapter({ daemonToken: TOKEN, db })
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req: Request, srv): Promise<Response> {
      const upgraded = await ws.tryUpgrade(req, srv)
      if (upgraded === true) return undefined as unknown as Response
      if (upgraded === false) return await app.fetch(req)
      return upgraded
    },
    websocket: ws.handlers,
  })
  return {
    db,
    server,
    url: `ws://${server.hostname}:${server.port}`,
    cleanup: async () => {
      server.stop(true)
      resetBroadcastersForTests()
    },
  }
}

/** Resolve as soon as `pred()` holds (polling), capped at `capMs`. */
async function waitUntil(pred: () => boolean, capMs = 1000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > capMs) return
    await new Promise((r) => setTimeout(r, 5))
  }
}

const hasType = (msgs: Array<{ type: string }>, type: string): boolean =>
  msgs.some((m) => m.type === type)

describe('/ws/repo-imports/{batchId} (RFC-033)', () => {
  let h: Harness
  beforeEach(async () => {
    h = await buildHarness()
  })
  afterEach(async () => {
    await h.cleanup()
  })

  test('opens with hello frame and receives row.update + batch.completed broadcasts', async () => {
    const batchId = '01HXX-fake'
    const received: Array<{ type: string }> = []
    const sock = new WebSocket(`${h.url}/ws/repo-imports/${batchId}?token=${TOKEN}`)
    await new Promise<void>((res, rej) => {
      sock.addEventListener('open', () => res())
      sock.addEventListener('error', () => rej(new Error('ws error')))
    })
    sock.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    // Wait for hello frame.
    await waitUntil(() => hasType(received, 'hello'))

    repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(batchId), {
      type: 'row.update',
      row: {
        rowId: 'r1',
        inputUrl: 'https://h/a.git',
        inputUrlRedacted: 'https://h/a.git',
        status: 'done',
        cold: true,
        fetchOk: null,
        cachedRepoId: 'cr1',
        errorCode: null,
        message: 'cloned',
        queuedAt: '2026-05-17T00:00:00.000Z',
        startedAt: '2026-05-17T00:00:01.000Z',
        finishedAt: '2026-05-17T00:00:02.000Z',
      },
    })
    repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(batchId), {
      type: 'batch.completed',
      batchId,
      completedAt: '2026-05-17T00:00:03.000Z',
    })
    await waitUntil(() => hasType(received, 'row.update') && hasType(received, 'batch.completed'))
    sock.close()

    const types = received.map((m) => m.type)
    expect(types[0]).toBe('hello')
    expect(types).toContain('row.update')
    expect(types).toContain('batch.completed')
    const hello = received[0] as { type: string; channel: string }
    expect(hello.channel).toBe(`repo-imports/${batchId}`)
  })

  test('broadcast on a different batchId is not delivered', async () => {
    const myBatch = 'batch-A'
    const otherBatch = 'batch-B'
    const received: Array<{ type: string }> = []
    const sock = new WebSocket(`${h.url}/ws/repo-imports/${myBatch}?token=${TOKEN}`)
    await new Promise<void>((res) => sock.addEventListener('open', () => res()))
    sock.addEventListener('message', (e) => received.push(JSON.parse(String(e.data))))
    await waitUntil(() => hasType(received, 'hello'))

    repoImportsBroadcaster.broadcast(REPO_IMPORT_CHANNEL(otherBatch), {
      type: 'batch.completed',
      batchId: otherBatch,
      completedAt: '2026-05-17T00:00:01.000Z',
    })
    // Negative assertion: we must give an *erroneous* cross-batch delivery a
    // bounded window to (wrongly) arrive before concluding it didn't. Unlike the
    // positive waits above, this one cannot be predicate-driven — keep a short
    // fixed settle.
    await new Promise((r) => setTimeout(r, 50))
    sock.close()

    // Only the hello frame should be present.
    const types = received.map((m) => m.type)
    expect(types).toEqual(['hello'])
  })

  test('missing token returns 401 (no upgrade)', async () => {
    const res = await fetch(
      `http://${h.server.hostname}:${h.server.port}/ws/repo-imports/some-batch`,
    )
    expect(res.status).toBe(401)
  })
})
