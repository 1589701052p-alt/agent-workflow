// RFC-028 T2 — locks migration 0011: introduces `mcps` table and adds
// `agents.mcp` column (default '[]').
//
// Legacy agent rows inserted BEFORE this migration come back with mcp == '[]'
// (the column default), so AgentSchema validates them and downstream readers
// (services/runner.ts buildInlineConfig) treat them as "no MCPs declared".
//
// If this test fails, RFC-028's "DB stores agent MCP names" + "mcps table
// exists" assumptions (proposal §5, design §2) are broken.

import { describe, expect, test, beforeEach } from 'bun:test'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { agents, mcps } from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('migration 0011 (RFC-028 mcps + agents.mcp)', () => {
  let db: DbClient
  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('mcps table exists with unique name + sensible defaults', () => {
    const id = ulid()
    db.insert(mcps)
      .values({
        id,
        name: 'postgres-prod',
        description: 'prod read replica',
        type: 'local',
        config: JSON.stringify({ command: ['uvx', 'postgres-mcp'] }),
      })
      .run()

    const rows = db.select().from(mcps).all()
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.id).toBe(id)
    expect(r.name).toBe('postgres-prod')
    expect(r.type).toBe('local')
    expect(JSON.parse(r.config)).toEqual({ command: ['uvx', 'postgres-mcp'] })
    expect(r.enabled).toBe(true)
    expect(r.schemaVersion).toBe(1)
    expect(r.createdAt).toBeGreaterThan(0)
    expect(r.updatedAt).toBeGreaterThan(0)
  })

  test('mcps.name UNIQUE constraint rejects duplicates', () => {
    db.insert(mcps).values({ id: ulid(), name: 'shared', type: 'local', config: '{}' }).run()
    expect(() =>
      db.insert(mcps).values({ id: ulid(), name: 'shared', type: 'remote', config: '{}' }).run(),
    ).toThrow()
  })

  test('mcps accepts type=remote', () => {
    db.insert(mcps)
      .values({
        id: ulid(),
        name: 'sentry',
        type: 'remote',
        config: JSON.stringify({ url: 'https://sentry.io/mcp' }),
      })
      .run()
    const rows = db.select().from(mcps).all()
    expect(rows[0]!.type).toBe('remote')
  })

  test('agents.mcp column defaults to "[]" when row inserted without value', () => {
    // Insert a row using raw SQL so we *don't* pass mcp — proves the column
    // default kicks in for migrations on top of pre-RFC-028 data.
    db.run(sql`INSERT INTO agents (id, name) VALUES ('a1', 'legacy')`)

    const rows = db.select().from(agents).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.mcp).toBe('[]')
    expect(JSON.parse(rows[0]!.mcp)).toEqual([])
  })

  test('agents.mcp stores JSON string[]', () => {
    db.insert(agents)
      .values({
        id: ulid(),
        name: 'auditor',
        mcp: JSON.stringify(['postgres-prod', 'sentry']),
      })
      .run()

    const rows = db.select().from(agents).all()
    expect(JSON.parse(rows[0]!.mcp)).toEqual(['postgres-prod', 'sentry'])
  })
})
