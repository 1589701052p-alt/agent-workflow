// GET /api/daemon surfaces the daemon's EFFECTIVE binding (the host:port it is
// actually listening on right now), read from the run-info file — deliberately
// distinct from the PERSISTED bindHost/bindPort returned by GET /api/config
// (which is blank for an ephemeral port and is overridden, without being written
// back, by the --host/--port launch flags). Regression guard for the Network
// settings tab "current actual binding" readout: locks the endpoint's presence,
// its null-on-absent behaviour, auth gating, and the shared readDaemonInfo parse.

import { rimrafDir } from './helpers/cleanup'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb } from '../src/db/client'
import { createApp } from '../src/server'
import { readDaemonInfo, type DaemonInfo } from '../src/util/daemonInfo'

const DAEMON_TOKEN = 'a'.repeat(64)
const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const SAMPLE: DaemonInfo = {
  pid: 4321,
  host: '127.0.0.1',
  port: 52341,
  url: 'http://127.0.0.1:52341/',
  startedAt: '2026-07-08T00:00:00.000Z',
}

const tmpDirs: string[] = []
function tmpInfoFile(contents: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'aw-daemoninfo-'))
  tmpDirs.push(dir)
  const path = join(dir, '.daemon.info')
  if (contents !== null) writeFileSync(path, contents, 'utf-8')
  return path
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    rimrafDir(tmpDirs.pop()!)
  }
})

function makeApp(daemonInfoPath: string) {
  return createApp({
    token: DAEMON_TOKEN,
    configPath: '/tmp/aw-test-config-never-used.json',
    daemonInfoPath,
    opencodeVersion: '1.14.25',
    dbVersion: 1,
    db: createInMemoryDb(MIGRATIONS),
  })
}

function authedGet(app: ReturnType<typeof makeApp>, path: string) {
  return app.fetch(
    new Request(`http://d.test${path}`, {
      headers: { Authorization: `Bearer ${DAEMON_TOKEN}` },
    }),
  )
}

describe('readDaemonInfo util', () => {
  test('parses a present run-info file', () => {
    expect(readDaemonInfo(tmpInfoFile(JSON.stringify(SAMPLE)))).toEqual(SAMPLE)
  })

  test('returns null when the file is absent', () => {
    expect(readDaemonInfo(join(tmpdir(), 'aw-nope-does-not-exist.info'))).toBeNull()
  })

  test('returns null on garbled JSON rather than throwing', () => {
    expect(readDaemonInfo(tmpInfoFile('{ not json'))).toBeNull()
  })
})

describe('GET /api/daemon', () => {
  test('returns the effective binding when the run-info file exists', async () => {
    const app = makeApp(tmpInfoFile(JSON.stringify(SAMPLE)))
    const res = await authedGet(app, '/api/daemon')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(SAMPLE)
  })

  test('returns null (not 500) when the run-info file is absent', async () => {
    const app = makeApp(join(tmpdir(), 'aw-absent-daemon-info.info'))
    const res = await authedGet(app, '/api/daemon')
    expect(res.status).toBe(200)
    expect(await res.json()).toBeNull()
  })

  test('requires authentication', async () => {
    const app = makeApp(tmpInfoFile(JSON.stringify(SAMPLE)))
    const res = await app.fetch(new Request('http://d.test/api/daemon'))
    expect(res.status).toBe(401)
  })
})
