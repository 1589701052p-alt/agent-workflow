// RFC-113 PR-A — runtime IS a full execution profile (model/variant/temperature/
// steps/maxSteps on the runtime row), multiple runtimes per binary, and the two
// one-time startup migrations: config defaults -> built-in rows, and existing
// agents' params -> deduped runtime profiles (re-pointing agents). The golden
// invariant: after the agent migration, the runtime an agent points at carries
// EXACTLY the params the agent had — so its inline execution config is unchanged.

import { beforeEach, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, runtimes } from '../src/db/schema'
import {
  createRuntime,
  getRuntime,
  listRuntimes,
  migrateAgentParamsToRuntimes,
  migrateConfigIntoBuiltins,
  runtimeRowToView,
  seedBuiltinRuntimes,
} from '../src/services/runtimeRegistry'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

interface AgentParams {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  steps?: number | null
  maxSteps?: number | null
}
async function insertAgent(
  db: DbClient,
  name: string,
  runtime: string | null,
  params: AgentParams = {},
  builtin = false,
): Promise<string> {
  const id = ulid()
  await db.insert(agents).values({ id, name, ...(runtime ? { runtime } : {}), ...params, builtin })
  return id
}
async function agentRow(db: DbClient, id: string) {
  return (await db.select().from(agents).where(eq(agents.id, id)))[0]
}

async function fresh(): Promise<DbClient> {
  const db = createInMemoryDb(MIGRATIONS)
  await seedBuiltinRuntimes(db)
  return db
}

describe('runtime profile CRUD + multi-runtime-per-binary (RFC-113 PR-A)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = await fresh()
  })

  test('create carries model + generation params; same binary, different name+params coexist', async () => {
    const a = await createRuntime(db, {
      name: 'opencode-opus',
      protocol: 'opencode',
      binaryPath: '/bin/oc',
      model: 'opus',
      temperature: 0.7,
      steps: 200,
    })
    const b = await createRuntime(db, {
      name: 'opencode-haiku',
      protocol: 'opencode',
      binaryPath: '/bin/oc', // SAME binary
      model: 'haiku',
      temperature: 0,
    })
    expect(a.model).toBe('opus')
    expect(a.temperature).toBe(0.7)
    expect(b.model).toBe('haiku')
    expect(b.binaryPath).toBe('/bin/oc') // same binary, distinct runtime
  })

  test('temperature out of range rejected', async () => {
    await expect(
      createRuntime(db, { name: 'bad', protocol: 'opencode', temperature: 3 }),
    ).rejects.toMatchObject({ code: 'runtime-temperature-invalid' })
  })

  test('runtimeRowToView marks the config default row', async () => {
    const oc = (await getRuntime(db, 'opencode'))!
    expect(runtimeRowToView(oc, 'opencode').isDefault).toBe(true)
    expect(runtimeRowToView(oc, 'claude-code').isDefault).toBe(false)
  })
})

describe('migrateConfigIntoBuiltins (RFC-113 §3.1)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = await fresh()
  })

  test('backfills config defaults onto the built-in rows (NULL cols only)', async () => {
    await migrateConfigIntoBuiltins(db, {
      opencodePath: '/usr/bin/oc',
      defaultModel: 'opus',
      defaultTemperature: 0.3,
      claudeCodePath: '/usr/bin/cc',
      defaultClaudeModel: 'sonnet',
    })
    const oc = (await getRuntime(db, 'opencode'))!
    expect(oc.binaryPath).toBe('/usr/bin/oc')
    expect(oc.model).toBe('opus')
    expect(oc.temperature).toBe(0.3)
    const cc = (await getRuntime(db, 'claude-code'))!
    expect(cc.binaryPath).toBe('/usr/bin/cc')
    expect(cc.model).toBe('sonnet')
  })

  test('idempotent + never clobbers an admin-edited built-in (??=)', async () => {
    await db.update(runtimes).set({ model: 'admin-picked' }).where(eq(runtimes.name, 'opencode'))
    await migrateConfigIntoBuiltins(db, { defaultModel: 'opus' })
    await migrateConfigIntoBuiltins(db, { defaultModel: 'opus' }) // twice
    expect((await getRuntime(db, 'opencode'))!.model).toBe('admin-picked') // not overwritten
  })
})

describe('migrateAgentParamsToRuntimes (RFC-113 §3.2 — golden invariant + dedup)', () => {
  let db: DbClient
  beforeEach(async () => {
    db = await fresh()
    // built-in opencode carries the config default model (as if §3.1 ran).
    await migrateConfigIntoBuiltins(db, { defaultModel: 'opus' })
  })

  test('agents with the SAME params share ONE created profile; distinct params -> distinct', async () => {
    const a1 = await insertAgent(db, 'a1', 'opencode', { model: 'haiku', temperature: 0 })
    const a2 = await insertAgent(db, 'a2', 'opencode', { model: 'haiku', temperature: 0 })
    const a3 = await insertAgent(db, 'a3', 'opencode', { model: 'sonnet', temperature: 0.5 })
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    const r1 = (await agentRow(db, a1))!.runtime
    const r2 = (await agentRow(db, a2))!.runtime
    const r3 = (await agentRow(db, a3))!.runtime
    expect(r1).toBe(r2) // same params -> same runtime
    expect(r1).not.toBe(r3) // distinct params -> distinct runtime
    // and the runtime carries the agent's params (golden).
    const rt1 = (await getRuntime(db, r1!))!
    expect(rt1.model).toBe('haiku')
    expect(rt1.temperature).toBe(0)
    // agent params cleared (single source).
    expect((await agentRow(db, a1))!.model).toBeNull()
  })

  test('an agent that MATCHES the built-in opencode (model=opus) reuses it', async () => {
    const a = await insertAgent(db, 'def', 'opencode', { model: 'opus' })
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    expect((await agentRow(db, a))!.runtime).toBe('opencode') // reused built-in
  })

  test('a BARE agent (no explicit params) is left on its runtime — adopts the new-model profile (idempotency root)', async () => {
    // RFC-113 refines Codex P1-1: the golden invariant pins agents that had
    // EXPLICIT params; a bare agent (model=NULL, nothing set) had no model
    // preference, so in the new "runtime decides" model it simply adopts its
    // runtime — and being skipped is exactly what makes a re-run a no-op.
    const a = await insertAgent(db, 'bare', 'opencode', { model: null })
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    expect((await agentRow(db, a))!.runtime).toBe('opencode') // unchanged
  })

  test('builtin (internal) agents are EXCLUDED from the migration (Codex P1-4)', async () => {
    const internal = await insertAgent(db, 'aw-fusion', 'opencode', { model: 'haiku' }, true)
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    const row = (await agentRow(db, internal))!
    expect(row.runtime).toBe('opencode') // untouched
    expect(row.model).toBe('haiku') // params NOT cleared (internal keeps its own)
  })

  test('idempotent — re-running makes no further changes', async () => {
    await insertAgent(db, 'x', 'opencode', { model: 'haiku' })
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    const after1 = (await listRuntimes(db)).length
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    expect((await listRuntimes(db)).length).toBe(after1) // no new runtimes
  })

  test('an agent already on a matching CUSTOM runtime is kept on it (Codex P2-1)', async () => {
    await createRuntime(db, {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: '/x',
      model: 'haiku',
    })
    // agent points at my-oc; its params equal my-oc's profile → stay put.
    const a = await insertAgent(db, 'keep', 'my-oc', { model: 'haiku' })
    await migrateAgentParamsToRuntimes(db, { defaultRuntime: 'opencode' })
    expect((await agentRow(db, a))!.runtime).toBe('my-oc')
  })
})
