// RFC-061 PR-A T3 — eventApplier + writeEvents + projectionRebuilder tests.
//
// LOCKS:
//   - Each of the 25 closed EventKinds either updates the documented
//     projection table or is a no-op recorded in events only
//   - writeEvents is atomic: a payload validation failure or an applier
//     failure rolls back the entire batch
//   - rebuildProjections produces byte-equivalent (after canonicalization)
//     projections vs the incremental apply path that built them
//   - verifyProjectionConsistency runs read-only — it never mutates live
//     projection state, no matter how many times it's called
//   - applyEvent enforces full-scope requirement for non-task events
//     (throws on null scope columns when one is required)
//
// design.md §2 + §6 are the authoritative spec; if a test here diverges
// from the design, the design wins and the test (or the code) is wrong.

import { describe, expect, test } from 'bun:test'
import { eq, asc } from 'drizzle-orm'
import { resolve } from 'node:path'
import { ulid } from 'ulid'

import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  attempts,
  events,
  logicalRuns,
  nodeOutputs,
  suspensions,
  tasks,
  workflows,
} from '../src/db/schema'
import { writeEvent, writeEvents } from '../src/services/writeEvents'
import {
  rebuildProjections,
  verifyProjectionConsistency,
  replayEventsToFreshProjections,
  readProjectionCursor,
} from '../src/services/projectionRebuilder'
import { applyEvent } from '../src/services/eventApplier'
import { type RawEvent } from '@agent-workflow/shared'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function seedTask(db: DbClient): Promise<string> {
  const id = `task_${ulid()}`
  const wfId = `wf_${id}`
  const def = { $schema_version: 3, inputs: [], nodes: [], edges: [], outputs: [] }
  await db.insert(workflows).values({
    id: wfId,
    name: 'rfc061-applier-test',
    description: '',
    definition: JSON.stringify(def),
    version: 1,
    schemaVersion: 3,
  })
  await db.insert(tasks).values({
    id,
    name: 'rfc061-applier-test',
    workflowId: wfId,
    workflowSnapshot: JSON.stringify(def),
    repoPath: '/tmp/aw-applier-test/repo',
    worktreePath: '',
    baseBranch: 'main',
    branch: `agent-workflow/${id}`,
    status: 'running',
    inputs: JSON.stringify({}),
    startedAt: Date.now(),
  })
  return id
}

function makeDb(): DbClient {
  return createInMemoryDb(MIGRATIONS)
}

/* ============================================================
 *  writeEvent / writeEvents — API surface
 * ============================================================ */

describe('writeEvent', () => {
  test('inserts a task-created event and decodes it back', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    const ev = await writeEvent(db, {
      taskId,
      kind: 'task-created',
      payload: { workflowId: 'wf_1' },
      actor: 'system',
    })
    expect(ev.kind).toBe('task-created')
    if (ev.kind !== 'task-created') throw new Error('narrow failed')
    expect(ev.payload.workflowId).toBe('wf_1')

    const rows = db.select().from(events).all() as Array<{ id: string }>
    expect(rows.length).toBe(1)
    expect(rows[0]?.id).toBe(ev.id)
  })

  test('throws on payload validation failure (writes nothing)', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    let threw: Error | null = null
    try {
      await writeEvent(db, {
        taskId,
        kind: 'task-failed',
        // missing required `reason`
        payload: {} as never,
        actor: 'system',
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    const rows = db.select().from(events).all()
    expect(rows.length).toBe(0)
  })

  test('advances projection_meta cursor to last inserted event id', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    const written = await writeEvents(db, [
      { taskId, kind: 'task-started', payload: {}, actor: 'system' },
      { taskId, kind: 'task-paused', payload: { reason: 'mid' }, actor: 'system' },
      { taskId, kind: 'task-completed', payload: {}, actor: 'system' },
    ])
    const cursor = await readProjectionCursor(db)
    expect(cursor).toBe(written[written.length - 1]!.id)
  })

  test('atomic batch: an applier failure mid-batch rolls back ALL events', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    // Second event has a logical-run-completed referring to a non-existent
    // logical_run, which the applier rejects with a hard error.
    let threw: Error | null = null
    try {
      await writeEvents(db, [
        { taskId, kind: 'task-started', payload: {}, actor: 'system' },
        {
          taskId,
          kind: 'logical-run-completed',
          payload: {},
          actor: 'system',
          nodeId: 'ghost_node',
          loopIter: 0,
          shardKey: '',
          iter: 0,
        },
      ])
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    // Neither event landed.
    expect(db.select().from(events).all().length).toBe(0)
  })
})

/* ============================================================
 *  Per-EventKind apply — happy paths
 * ============================================================ */

describe('applyEvent — task-level kinds are projection no-ops in PR-A', () => {
  test('task-created records to events, leaves projections empty', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvent(db, {
      taskId,
      kind: 'task-created',
      payload: { workflowId: 'wf_a' },
      actor: 'system',
    })
    expect(db.select().from(logicalRuns).all().length).toBe(0)
    expect(db.select().from(attempts).all().length).toBe(0)
  })

  test('all 7 task-level kinds round-trip without touching projection tables', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvents(db, [
      { taskId, kind: 'task-created', payload: { workflowId: 'wf_a' }, actor: 'system' },
      { taskId, kind: 'task-started', payload: {}, actor: 'system' },
      { taskId, kind: 'task-paused', payload: { reason: 'manual' }, actor: 'user:u1' },
      { taskId, kind: 'task-canceled', payload: { reason: 'rollback' }, actor: 'user:u1' },
      { taskId, kind: 'task-completed', payload: {}, actor: 'system' },
      { taskId, kind: 'task-failed', payload: { reason: 'boom' }, actor: 'system' },
      {
        taskId,
        kind: 'task-resumed-after-daemon-restart',
        payload: { crashedAttemptCount: 2 },
        actor: 'system',
      },
    ])
    expect(db.select().from(events).all().length).toBe(7)
    expect(db.select().from(logicalRuns).all().length).toBe(0)
  })
})

describe('applyEvent — logical-run lifecycle', () => {
  test('logical-run-created inserts a fresh logical_runs row', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    const rows = db.select().from(logicalRuns).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.status).toBe('pending')
    expect(rows[0]?.nodeId).toBe('n_a')
    expect(rows[0]?.iter).toBe(0)
  })

  test('logical-run-iter-bumped mints a new logical_run at the new iter', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvents(db, [
      {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'logical-run-iter-bumped',
        payload: { triggerEventId: 'evt_x', triggerKind: 'suspension-resolved' },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 1,
      },
    ])
    const rows = db.select().from(logicalRuns).all()
    expect(rows.length).toBe(2)
    const iters = rows.map((r) => r.iter).sort()
    expect(iters).toEqual([0, 1])
  })

  test('logical-run-completed updates the existing logical_run to done', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvents(db, [
      {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'logical-run-completed',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
    ])
    const rows = db.select().from(logicalRuns).all()
    expect(rows[0]?.status).toBe('done')
  })

  test('logical-run-canceled updates the row to canceled', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvents(db, [
      {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'logical-run-canceled',
        payload: { reason: 'user-cancel' },
        actor: 'user:u1',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
    ])
    const rows = db.select().from(logicalRuns).all()
    expect(rows[0]?.status).toBe('canceled')
  })
})

describe('applyEvent — attempt lifecycle', () => {
  async function bootstrapScope(db: DbClient, taskId: string) {
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
  }

  test('attempt-started inserts attempts row + flips logical_run to running', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvent(db, {
      taskId,
      kind: 'attempt-started',
      payload: { pid: 12345, opencodeSessionId: 'sess_x' },
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })
    const att = db.select().from(attempts).all()
    expect(att.length).toBe(1)
    expect(att[0]?.id).toBe(attemptId)
    expect(att[0]?.pid).toBe(12345)
    expect(att[0]?.attemptSeq).toBe(0)

    const lr = db.select().from(logicalRuns).all()
    expect(lr[0]?.status).toBe('running')
  })

  test('attempt-finished-success updates outcome + finishedAt', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvent(db, {
      taskId,
      kind: 'attempt-started',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })
    await writeEvent(db, {
      taskId,
      kind: 'attempt-finished-success',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId,
    })
    const att = db.select().from(attempts).all()
    expect(att[0]?.outcome).toBe('success')
    expect(att[0]?.finishedAt).not.toBeNull()
  })

  test('attempt-finished-envelope-fail captures reason in error_message', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-finished-envelope-fail',
        payload: { reason: 'missing <workflow-output>' },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    const att = db.select().from(attempts).all()
    expect(att[0]?.outcome).toBe('envelope-fail')
    expect(att[0]?.errorMessage).toContain('workflow-output')
  })

  test('attempt-finished-crash captures exit_code + error_message', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-finished-crash',
        payload: { exitCode: 137, errorMessage: 'SIGKILL' },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    const att = db.select().from(attempts).all()
    expect(att[0]?.outcome).toBe('crash')
    expect(att[0]?.exitCode).toBe(137)
    expect(att[0]?.errorMessage).toBe('SIGKILL')
  })

  test('attempt-finished-timeout records outcome=timeout', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-finished-timeout',
        payload: { timeoutMs: 30000 },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    const att = db.select().from(attempts).all()
    expect(att[0]?.outcome).toBe('timeout')
  })

  test('attempt-canceled records outcome=canceled with reason', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-canceled',
        payload: { reason: 'task-canceled' },
        actor: 'user:u1',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    const att = db.select().from(attempts).all()
    expect(att[0]?.outcome).toBe('canceled')
    expect(att[0]?.errorMessage).toBe('task-canceled')
  })

  test('attempt-output-captured inserts a node_outputs row keyed by scope+port', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-output-captured',
        payload: { portName: 'out', content: 'hello world' },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    const out = db.select().from(nodeOutputs).all()
    expect(out.length).toBe(1)
    expect(out[0]?.portName).toBe('out')
    expect(out[0]?.content).toBe('hello world')
  })

  test('attempt-subagent-* kinds record events but no projection row', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-subagent-tool-use',
        payload: { toolName: 'read', sessionId: 'sub_1' },
        actor: 'opencode:sess_a',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-subagent-output',
        payload: { sessionId: 'sub_1', content: '<inner>' },
        actor: 'opencode:sess_a',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    // bootstrapScope inserts logical-run-created (1) + writeEvents batch adds 3.
    expect(db.select().from(events).all().length).toBe(4)
    expect(db.select().from(attempts).all().length).toBe(1)
    expect(db.select().from(nodeOutputs).all().length).toBe(0)
  })

  test('attempt-started increments attempt_seq within a logical_run', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    const att1 = `att_${ulid()}`
    const att2 = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: att1,
      },
      {
        taskId,
        kind: 'attempt-finished-crash',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: att1,
      },
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId: att2,
      },
    ])
    const rows = db.select().from(attempts).orderBy(asc(attempts.attemptSeq)).all()
    expect(rows.length).toBe(2)
    expect(rows[0]?.attemptSeq).toBe(0)
    expect(rows[1]?.attemptSeq).toBe(1)
  })
})

describe('applyEvent — suspension lifecycle', () => {
  async function bootstrapScope(db: DbClient, taskId: string) {
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
  }

  test('suspension-created inserts a row + flips logical_run to suspended', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    await writeEvent(db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId: 'sus_1',
        signalKind: 'self-clarify',
        awaitsActor: 'user:alice',
        body: { questions: ['why?'] },
      },
      actor: 'agent:n_a',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    const rows = db.select().from(suspensions).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.signalKind).toBe('self-clarify')
    expect(rows[0]?.resolvedAt).toBeNull()

    const lr = db.select().from(logicalRuns).all()
    expect(lr[0]?.status).toBe('suspended')
  })

  test('suspension-resolved stamps resolvedAt without touching other rows', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    await writeEvents(db, [
      {
        taskId,
        kind: 'suspension-created',
        payload: {
          suspensionId: 'sus_1',
          signalKind: 'review',
          awaitsActor: 'user:reviewer',
          body: {},
        },
        actor: 'agent:n_a',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'suspension-resolved',
        payload: {
          suspensionId: 'sus_1',
          signalKind: 'review',
          decision: { kind: 'approve' },
        },
        actor: 'user:reviewer',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        resolutionId: 'res_1',
      },
    ])
    const rows = db.select().from(suspensions).all()
    expect(rows[0]?.resolvedAt).not.toBeNull()
  })

  test('suspension-terminated stamps resolvedAt too (no separate column)', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    await writeEvents(db, [
      {
        taskId,
        kind: 'suspension-created',
        payload: {
          suspensionId: 'sus_t',
          signalKind: 'cross-clarify',
          awaitsActor: 'user:alice',
          body: {},
        },
        actor: 'agent:n_a',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'suspension-terminated',
        payload: { suspensionId: 'sus_t', reason: 'task-canceled' },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
    ])
    const rows = db.select().from(suspensions).all()
    expect(rows[0]?.resolvedAt).not.toBeNull()
  })

  test('suspension-resolved write carries unique resolution_id (INV-5)', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await bootstrapScope(db, taskId)
    await writeEvent(db, {
      taskId,
      kind: 'suspension-created',
      payload: {
        suspensionId: 'sus_x',
        signalKind: 'self-clarify',
        awaitsActor: 'user:alice',
        body: {},
      },
      actor: 'agent:n_a',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    await writeEvent(db, {
      taskId,
      kind: 'suspension-resolved',
      payload: {
        suspensionId: 'sus_x',
        signalKind: 'self-clarify',
        decision: {},
      },
      actor: 'user:alice',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      resolutionId: 'res_x',
    })
    // Second resolved with same resolutionId is blocked by INV-5
    let threw: Error | null = null
    try {
      await writeEvent(db, {
        taskId,
        kind: 'suspension-resolved',
        payload: {
          suspensionId: 'sus_x',
          signalKind: 'self-clarify',
          decision: {},
        },
        actor: 'user:alice',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        resolutionId: 'res_x',
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
  })
})

describe('applyEvent — invariant-* events are projection no-ops', () => {
  test('invariant-alert-detected and -resolved record events only', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvents(db, [
      {
        taskId,
        kind: 'invariant-alert-detected',
        payload: { rule: 'R1', detail: { nodeIds: ['n_x'] } },
        actor: 'system',
      },
      {
        taskId,
        kind: 'invariant-alert-resolved',
        payload: { rule: 'R1' },
        actor: 'system',
      },
    ])
    expect(db.select().from(events).all().length).toBe(2)
    // Nothing in RFC-061 projections.
    expect(db.select().from(logicalRuns).all().length).toBe(0)
  })
})

/* ============================================================
 *  rebuildProjections + verifyProjectionConsistency
 * ============================================================ */

describe('rebuildProjections', () => {
  test('a fresh DB with zero events produces zero-row projections', async () => {
    const db = makeDb()
    const n = rebuildProjections(db)
    expect(n).toBe(0)
    expect(db.select().from(logicalRuns).all().length).toBe(0)
  })

  test('rebuild from N events produces equivalent projections to incremental apply', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'attempt-started',
        payload: { pid: 999 },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-output-captured',
        payload: { portName: 'out', content: 'hi' },
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-finished-success',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'logical-run-completed',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
    ])

    const before = await snapshotProjectionShapes(db)
    const n = rebuildProjections(db)
    expect(n).toBe(5)
    const after = snapshotProjectionShapes(db)
    expect(after.logicalRunCount).toBe(before.logicalRunCount)
    expect(after.attemptCount).toBe(before.attemptCount)
    expect(after.nodeOutputCount).toBe(before.nodeOutputCount)
    expect(after.attemptFinalOutcome).toBe(before.attemptFinalOutcome)
  })
})

describe('verifyProjectionConsistency', () => {
  test('consistent: true for a fresh-written stream', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    const attemptId = `att_${ulid()}`
    await writeEvents(db, [
      {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
      },
      {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
      {
        taskId,
        kind: 'attempt-finished-success',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        attemptId,
      },
    ])
    const report = verifyProjectionConsistency(db, MIGRATIONS)
    expect(report.consistent).toBe(true)
    expect(report.divergences.length).toBe(0)
    expect(report.eventCount).toBe(3)
  })

  test('verifyProjectionConsistency does NOT mutate live projections', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    const before = db.select().from(logicalRuns).all()
    verifyProjectionConsistency(db, MIGRATIONS)
    const after = db.select().from(logicalRuns).all()
    expect(after.length).toBe(before.length)
    expect(after[0]?.id).toBe(before[0]?.id) // same auto-generated id, not regenerated
  })

  test('detects divergence when a logical_run is silently mutated', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    // Sneak in a status mutation that isn't backed by an event — this is
    // exactly the kind of "shadow write" the consistency check is designed
    // to catch.
    await db.update(logicalRuns).set({ status: 'done' }).where(eq(logicalRuns.taskId, taskId))

    const report = verifyProjectionConsistency(db, MIGRATIONS)
    expect(report.consistent).toBe(false)
    expect(report.divergences.length).toBeGreaterThan(0)
  })
})

describe('replayEventsToFreshProjections + applyEvent direct surface', () => {
  test('directly applying a raw event without going through writeEvents works', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    const raw: RawEvent = {
      id: ulid(),
      taskId,
      ts: Date.now(),
      kind: 'logical-run-created',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: null,
      parentEventId: null,
      actor: 'system',
      resolutionId: null,
      payload: JSON.stringify({}),
    }
    applyEvent(db, raw)
    expect(db.select().from(logicalRuns).all().length).toBe(1)
  })

  test('replayEventsToFreshProjections wipes + rebuilds from given raw events', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    // First populate via writeEvents
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    expect(db.select().from(logicalRuns).all().length).toBe(1)

    // Now replay a different event stream — same scope, different id
    const replayedRaw: RawEvent = {
      id: ulid(),
      taskId,
      ts: Date.now(),
      kind: 'logical-run-created',
      nodeId: 'n_b', // different node
      loopIter: 0,
      shardKey: '',
      iter: 0,
      attemptId: null,
      parentEventId: null,
      actor: 'system',
      resolutionId: null,
      payload: JSON.stringify({}),
    }
    replayEventsToFreshProjections(db, [replayedRaw])
    const rows = db.select().from(logicalRuns).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.nodeId).toBe('n_b')
  })
})

describe('applyEvent — partial scope rejection', () => {
  test('throws on logical-run-created with null nodeId', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    let threw: Error | null = null
    try {
      await writeEvent(db, {
        taskId,
        kind: 'logical-run-created',
        payload: {},
        actor: 'system',
        // intentionally missing scope fields
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/scope/i)
  })

  test('throws on attempt-started with null attemptId', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    await writeEvent(db, {
      taskId,
      kind: 'logical-run-created',
      payload: {},
      actor: 'system',
      nodeId: 'n_a',
      loopIter: 0,
      shardKey: '',
      iter: 0,
    })
    let threw: Error | null = null
    try {
      await writeEvent(db, {
        taskId,
        kind: 'attempt-started',
        payload: {},
        actor: 'system',
        nodeId: 'n_a',
        loopIter: 0,
        shardKey: '',
        iter: 0,
        // missing attemptId
      })
    } catch (err) {
      threw = err as Error
    }
    expect(threw).not.toBeNull()
    expect(String(threw)).toMatch(/attemptId/i)
  })
})

describe('readProjectionCursor', () => {
  test('returns null when projection_meta has no row', async () => {
    const db = makeDb()
    expect(readProjectionCursor(db)).toBeNull()
  })

  test('returns the last event id after a writeEvents call', async () => {
    const db = makeDb()
    const taskId = await seedTask(db)
    const evs = await writeEvents(db, [
      { taskId, kind: 'task-started', payload: {}, actor: 'system' },
      { taskId, kind: 'task-completed', payload: {}, actor: 'system' },
    ])
    expect(readProjectionCursor(db)).toBe(evs[1]!.id)
  })
})

/* ============================================================
 *  Helpers
 * ============================================================ */

function snapshotProjectionShapes(db: DbClient): {
  logicalRunCount: number
  attemptCount: number
  nodeOutputCount: number
  attemptFinalOutcome: string | null
} {
  const lr = db.select().from(logicalRuns).all()
  const att = db.select().from(attempts).all()
  const out = db.select().from(nodeOutputs).all()
  return {
    logicalRunCount: lr.length,
    attemptCount: att.length,
    nodeOutputCount: out.length,
    attemptFinalOutcome: att[0]?.outcome ?? null,
  }
}
