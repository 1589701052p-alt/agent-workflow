// RFC-061 PR-A T1 — migration 0033 lands the event-sourced execution
// model schema: `events` (append-only) + 5 projections + projection_meta.
//
// LOCKS:
//   - 6 tables exist post-migrate with the expected columns
//   - INV-1 trigger `events_no_update` blocks any UPDATE on events
//   - INV-3 partial unique `uq_suspensions_open` allows ≤1 open suspension
//     per logical_run while permitting unlimited resolved rows
//   - INV-4 full unique `uq_logical_runs_scope` blocks duplicate
//     (taskId, nodeId, loopIter, shardKey, iter)
//   - INV-5 partial unique `uq_events_resolution` blocks duplicate
//     non-null resolution_id while permitting unlimited NULL rows
//   - CHECK constraints close 25 EventKinds and 6 SignalKinds at the DB
//     layer (a non-existent kind hard-fails the INSERT)
//   - `projection_meta` rejects any id != 1 (single-row invariant)
//   - shard_key sentinel `''` is the default and works with composite PKs

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'

import { createInMemoryDb } from '../src/db/client'
import {
  attempts,
  events,
  logicalRuns,
  nodeOutputs,
  projectionMeta,
  suspensions,
  tasks,
  workflows,
} from '../src/db/schema'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

const MIGRATION_FILE = resolve(MIGRATIONS, '0033_rfc061_events_projections.sql')

async function seedTask(db: ReturnType<typeof createInMemoryDb>): Promise<string> {
  const id = `task_${Math.random().toString(36).slice(2, 8)}`
  const wfId = `wf_${id}`
  const def = { $schema_version: 3, inputs: [], nodes: [], edges: [], outputs: [] }
  await db.insert(workflows).values({
    id: wfId,
    name: 'rfc061-mig-test',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id,
    name: 'rfc061-mig-test',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-mig-0033/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return id
}

async function seedLogicalRun(
  db: ReturnType<typeof createInMemoryDb>,
  taskId: string,
  partial?: Partial<{
    id: string
    nodeId: string
    loopIter: number
    shardKey: string
    iter: number
    status: 'pending' | 'running' | 'suspended' | 'done' | 'failed' | 'canceled'
  }>,
): Promise<string> {
  const id = partial?.id ?? ulid()
  await db.insert(logicalRuns).values({
    id,
    taskId,
    nodeId: partial?.nodeId ?? 'n_designer',
    loopIter: partial?.loopIter ?? 0,
    shardKey: partial?.shardKey ?? '',
    iter: partial?.iter ?? 0,
    status: partial?.status ?? 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastEventId: ulid(),
  })
  return id
}

describe('RFC-061 migration 0033 — table & index presence', () => {
  test('migration SQL file exists and declares all 6 tables', () => {
    const text = readFileSync(MIGRATION_FILE, 'utf8')
    for (const table of [
      'events',
      'logical_runs',
      'attempts',
      'node_outputs',
      'suspensions',
      'projection_meta',
    ]) {
      expect(text).toMatch(new RegExp(`CREATE TABLE \`${table}\``))
    }
    // INV-1 trigger
    expect(text).toMatch(/CREATE TRIGGER `events_no_update`/)
    // INV-3 partial unique
    expect(text).toMatch(/CREATE UNIQUE INDEX `uq_suspensions_open`/)
    // INV-4 full unique
    expect(text).toMatch(/CREATE UNIQUE INDEX `uq_logical_runs_scope`/)
    // INV-5 partial unique
    expect(text).toMatch(/CREATE UNIQUE INDEX `uq_events_resolution`/)
  })

  test('all 6 RFC-061 tables present in sqlite_master post-migrate', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const tableNames = db
      .select({ name: sql<string>`name` })
      .from(sql`sqlite_master`)
      .where(sql`type = 'table'`)
      .all() as Array<{ name: string }>
    const names = new Set(tableNames.map((r) => r.name))
    for (const t of [
      'events',
      'logical_runs',
      'attempts',
      'node_outputs',
      'suspensions',
      'projection_meta',
    ]) {
      expect(names.has(t)).toBe(true)
    }
  })

  test('events has expected columns including nullable scope fields', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db
      .select({
        name: sql<string>`name`,
        type: sql<string>`type`,
        notnull: sql<number>`"notnull"`,
      })
      .from(sql`pragma_table_info('events')`)
      .all() as Array<{ name: string; type: string; notnull: number }>
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]))
    expect(byName.id?.notnull).toBe(1)
    expect(byName.task_id?.notnull).toBe(1)
    expect(byName.kind?.notnull).toBe(1)
    expect(byName.node_id?.notnull).toBe(0) // scope nullable
    expect(byName.loop_iter?.notnull).toBe(0)
    expect(byName.shard_key?.notnull).toBe(0)
    expect(byName.iter?.notnull).toBe(0)
    expect(byName.resolution_id?.notnull).toBe(0)
    expect(byName.payload?.notnull).toBe(1)
  })

  test('logical_runs.shard_key defaults to empty string sentinel', () => {
    const db = createInMemoryDb(MIGRATIONS)
    const cols = db
      .select({
        name: sql<string>`name`,
        dflt: sql<string | null>`dflt_value`,
      })
      .from(sql`pragma_table_info('logical_runs')`)
      .all() as Array<{ name: string; dflt: string | null }>
    const sk = cols.find((c) => c.name === 'shard_key')
    expect(sk?.dflt).toBe("''")
    const lk = cols.find((c) => c.name === 'loop_iter')
    expect(lk?.dflt).toBe('0')
  })
})

describe('RFC-061 migration 0033 — INV-1: events append-only trigger', () => {
  test('INSERT into events succeeds with valid kind', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(events).values({
      id: ulid(),
      taskId,
      ts: Date.now(),
      kind: 'task-created',
      actor: 'system',
      payload: '{}',
    })
    const rows = db.select().from(events).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.kind).toBe('task-created')
  })

  test('UPDATE on events is blocked by events_no_update trigger', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const id = ulid()
    await db.insert(events).values({
      id,
      taskId,
      ts: Date.now(),
      kind: 'task-started',
      actor: 'system',
      payload: '{}',
    })
    let threw: Error | null = null
    try {
      await db
        .update(events)
        .set({ payload: '{"mutated":true}' })
        .where(sql`id = ${id}`)
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/append-only/i)
  })

  test('CHECK constraint rejects unknown event kind', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    let threw: Error | null = null
    try {
      // Cast bypasses the compile-time enum check so the runtime
      // CHECK constraint is the one being exercised.
      await db.insert(events).values({
        id: ulid(),
        taskId,
        ts: Date.now(),
        kind: 'task-frobnicated' as unknown as 'task-created',
        actor: 'system',
        payload: '{}',
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
  })
})

describe('RFC-061 migration 0033 — INV-3: ≤1 open suspension per logical_run', () => {
  test('two OPEN suspensions on the same logical_run are blocked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const lrId = await seedLogicalRun(db, taskId)
    await db.insert(suspensions).values({
      id: ulid(),
      logicalRunId: lrId,
      signalKind: 'self-clarify',
      awaitsActor: 'user',
      payload: '{}',
      createdAt: Date.now(),
    })
    let threw: Error | null = null
    try {
      await db.insert(suspensions).values({
        id: ulid(),
        logicalRunId: lrId,
        signalKind: 'review',
        awaitsActor: 'user',
        payload: '{}',
        createdAt: Date.now(),
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/UNIQUE constraint failed/i)
  })

  test('a resolved suspension and a fresh open suspension coexist', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const lrId = await seedLogicalRun(db, taskId)
    await db.insert(suspensions).values({
      id: 'sus_old',
      logicalRunId: lrId,
      signalKind: 'self-clarify',
      awaitsActor: 'user',
      payload: '{}',
      createdAt: Date.now(),
      resolvedAt: Date.now() + 1,
    })
    await db.insert(suspensions).values({
      id: 'sus_new',
      logicalRunId: lrId,
      signalKind: 'cross-clarify',
      awaitsActor: 'user',
      payload: '{}',
      createdAt: Date.now() + 2,
    })
    const all = db.select().from(suspensions).all()
    expect(all.length).toBe(2)
    expect(all.filter((s) => s.resolvedAt === null).length).toBe(1)
  })
})

describe('RFC-061 migration 0033 — INV-4: scope uniqueness on logical_runs', () => {
  test('two logical_runs with identical scope+iter are blocked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedLogicalRun(db, taskId, { nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 0 })
    let threw: Error | null = null
    try {
      await seedLogicalRun(db, taskId, { nodeId: 'n_a', loopIter: 0, shardKey: '', iter: 0 })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/UNIQUE constraint failed/i)
  })

  test('different iter on same scope is allowed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedLogicalRun(db, taskId, { nodeId: 'n_a', iter: 0 })
    await seedLogicalRun(db, taskId, { nodeId: 'n_a', iter: 1 })
    const rows = db.select().from(logicalRuns).all()
    expect(rows.length).toBe(2)
  })

  test('different shard_key on same scope is allowed (fanout case)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await seedLogicalRun(db, taskId, { nodeId: 'n_a', shardKey: 'file_a.ts', iter: 0 })
    await seedLogicalRun(db, taskId, { nodeId: 'n_a', shardKey: 'file_b.ts', iter: 0 })
    const rows = db.select().from(logicalRuns).all()
    expect(rows.length).toBe(2)
  })
})

describe('RFC-061 migration 0033 — INV-5: resolution_id is unique when present', () => {
  test('two events with the same resolution_id are blocked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const resId = 'res_first'
    await db.insert(events).values({
      id: ulid(),
      taskId,
      ts: Date.now(),
      kind: 'suspension-resolved',
      actor: 'user:u1',
      resolutionId: resId,
      payload: '{}',
    })
    let threw: Error | null = null
    try {
      await db.insert(events).values({
        id: ulid(),
        taskId,
        ts: Date.now(),
        kind: 'suspension-resolved',
        actor: 'user:u1',
        resolutionId: resId,
        payload: '{}',
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/UNIQUE constraint failed/i)
  })

  test('many events with NULL resolution_id coexist (partial unique)', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    for (let i = 0; i < 5; i++) {
      await db.insert(events).values({
        id: ulid(),
        taskId,
        ts: Date.now() + i,
        kind: 'attempt-started',
        actor: 'system',
        payload: '{}',
      })
    }
    const rows = db.select().from(events).all()
    expect(rows.length).toBe(5)
    expect(rows.every((r) => r.resolutionId === null)).toBe(true)
  })
})

describe('RFC-061 migration 0033 — node_outputs composite PK works under sentinel', () => {
  test('duplicate (scope, port_name) write is blocked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeOutputs).values({
      taskId,
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      portName: 'out',
      content: 'first',
      capturedAt: Date.now(),
      sourceEventId: ulid(),
    })
    let threw: Error | null = null
    try {
      await db.insert(nodeOutputs).values({
        taskId,
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        portName: 'out',
        content: 'second',
        capturedAt: Date.now() + 1,
        sourceEventId: ulid(),
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/UNIQUE|PRIMARY/i)
  })

  test('same port name in two different shards is allowed', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    await db.insert(nodeOutputs).values({
      taskId,
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: 'shard_x',
      iter: 0,
      portName: 'out',
      content: 'x',
      capturedAt: Date.now(),
      sourceEventId: ulid(),
    })
    await db.insert(nodeOutputs).values({
      taskId,
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: 'shard_y',
      iter: 0,
      portName: 'out',
      content: 'y',
      capturedAt: Date.now() + 1,
      sourceEventId: ulid(),
    })
    const rows = db.select().from(nodeOutputs).all()
    expect(rows.length).toBe(2)
  })
})

describe('RFC-061 migration 0033 — projection_meta single-row invariant', () => {
  test('row with id=1 is acceptable', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    await db.insert(projectionMeta).values({
      id: 1,
      lastProcessedEventId: null,
      rebuiltAt: Date.now(),
    })
    const rows = db.select().from(projectionMeta).all()
    expect(rows.length).toBe(1)
  })

  test('CHECK rejects id=2', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    let threw: Error | null = null
    try {
      await db.insert(projectionMeta).values({
        id: 2,
        lastProcessedEventId: null,
        rebuiltAt: Date.now(),
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/CHECK constraint failed/i)
  })
})

describe('RFC-061 migration 0033 — attempts seq uniqueness', () => {
  test('two attempts with same seq on same logical_run are blocked', async () => {
    const db = createInMemoryDb(MIGRATIONS)
    const taskId = await seedTask(db)
    const lrId = await seedLogicalRun(db, taskId)
    await db.insert(attempts).values({
      id: 'att_0',
      logicalRunId: lrId,
      attemptSeq: 0,
      startedAt: Date.now(),
    })
    let threw: Error | null = null
    try {
      await db.insert(attempts).values({
        id: 'att_0_dup',
        logicalRunId: lrId,
        attemptSeq: 0,
        startedAt: Date.now() + 1,
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/UNIQUE constraint failed/i)
  })
})
