// Locks in RFC-005 PR-A T4: workflow $schema_version 1 → 2 transparent
// upgrade.
//
// Contract:
//   - GET path: rowToWorkflow → migrateDefinitionToLatest. v1 docs come back
//     as v2 in-memory; the on-disk row is not modified until the next PUT.
//   - POST / PUT paths: normalize via migrateDefinitionToLatest before
//     storing, so new writes always land at the latest version.
//   - Pure helper: idempotent (v2 → v2 is identity).
//
// If this goes red, check packages/backend/src/services/workflow.ts and
// packages/shared/src/schemas/workflow.ts in lock-step.

import type { Workflow, WorkflowDefinition } from '@agent-workflow/shared'
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { openDb, type DbClient } from '../src/db/client'
import { workflows } from '../src/db/schema'
import { ulid } from 'ulid'
import {
  createWorkflow,
  getWorkflow,
  migrateDefinitionToLatest,
  updateWorkflow,
} from '../src/services/workflow'

const migrationsFolder = resolve(import.meta.dirname, '..', 'db', 'migrations')

describe('RFC-005 migrateDefinitionToLatest pure helper', () => {
  test('v1 → v2 (only schema_version field changes)', () => {
    const v1: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
      nodes: [{ id: 'in_1', kind: 'input', inputKey: 'topic' }],
      edges: [],
    }
    const v2 = migrateDefinitionToLatest(v1)
    expect(v2.$schema_version).toBe(2)
    expect(v2.inputs).toEqual(v1.inputs)
    expect(v2.nodes).toEqual(v1.nodes)
    expect(v2.edges).toEqual(v1.edges)
  })

  test('v2 → v2 (identity)', () => {
    const v2: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [],
      edges: [],
    }
    const out = migrateDefinitionToLatest(v2)
    expect(out.$schema_version).toBe(2)
    // Same instance returned when no upgrade needed.
    expect(out).toBe(v2)
  })

  test('v1 upgrade does not mutate input (returns a new object)', () => {
    const v1: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [],
      edges: [],
    }
    const v2 = migrateDefinitionToLatest(v1)
    expect(v1.$schema_version).toBe(1) // original untouched
    expect(v2.$schema_version).toBe(2)
    expect(v2).not.toBe(v1)
  })
})

describe('RFC-005 GET path: v1 row → v2 returned by getWorkflow', () => {
  let tmp: string
  let db: DbClient

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-migrate-'))
    db = openDb({ path: join(tmp, 'db.sqlite'), migrationsFolder })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('legacy v1 row → getWorkflow returns v2 definition', async () => {
    const id = ulid()
    const now = Date.now()
    // Insert raw v1 row (simulating a workflow stored before RFC-005 shipped).
    await db.insert(workflows).values({
      id,
      name: 'legacy',
      description: '',
      definition: JSON.stringify({
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
        nodes: [{ id: 'in_1', kind: 'input', inputKey: 'topic' }],
        edges: [],
      }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })

    const got = await getWorkflow(db, id)
    expect(got).not.toBeNull()
    const wf = got as Workflow
    expect(wf.definition.$schema_version).toBe(2)
    // Shape otherwise unchanged.
    expect(wf.definition.inputs).toHaveLength(1)
    expect(wf.definition.nodes).toHaveLength(1)
    expect(wf.definition.nodes[0]?.id).toBe('in_1')
  })

  test('on-disk row stays at v1 until next PUT (heal-on-edit pattern)', async () => {
    const id = ulid()
    const now = Date.now()
    await db.insert(workflows).values({
      id,
      name: 'legacy',
      description: '',
      definition: JSON.stringify({ $schema_version: 1, inputs: [], nodes: [], edges: [] }),
      version: 1,
      createdAt: now,
      updatedAt: now,
    })
    // GET should not modify the DB row.
    await getWorkflow(db, id)
    const rows = await db.select().from(workflows).where(eq(workflows.id, id))
    const raw = JSON.parse(rows[0]!.definition) as { $schema_version: number }
    expect(raw.$schema_version).toBe(1)
  })
})

describe('RFC-005 POST / PUT paths normalize v1 → v2 on write', () => {
  let tmp: string
  let db: DbClient

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'aw-migrate-write-'))
    db = openDb({ path: join(tmp, 'db.sqlite'), migrationsFolder })
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  test('createWorkflow with v1 def → DB row stores v2', async () => {
    const created = await createWorkflow(db, {
      name: 'new-flow',
      description: '',
      definition: {
        $schema_version: 1,
        inputs: [],
        nodes: [],
        edges: [],
      },
    })
    // Returned via getWorkflow which always upgrades, so we read the raw row
    // directly to confirm the on-disk shape is v2.
    const rows = await db.select().from(workflows).where(eq(workflows.id, created.id))
    const raw = JSON.parse(rows[0]!.definition) as { $schema_version: number }
    expect(raw.$schema_version).toBe(2)
  })

  test('updateWorkflow with v1 def patch → DB row stores v2', async () => {
    // Seed a workflow at v2 (createWorkflow normalizes either way).
    const created = await createWorkflow(db, {
      name: 'flow',
      description: '',
      definition: { $schema_version: 2, inputs: [], nodes: [], edges: [] },
    })

    // PUT with a v1 patch — could happen from an older client.
    await updateWorkflow(db, created.id, {
      definition: {
        $schema_version: 1,
        inputs: [{ kind: 'text', key: 'k', label: 'k' }],
        nodes: [],
        edges: [],
      },
    })

    const rows = await db.select().from(workflows).where(eq(workflows.id, created.id))
    const raw = JSON.parse(rows[0]!.definition) as {
      $schema_version: number
      inputs: Array<{ kind: string; key: string; label: string }>
    }
    expect(raw.$schema_version).toBe(2)
    expect(raw.inputs).toEqual([{ kind: 'text', key: 'k', label: 'k' }])
  })
})
