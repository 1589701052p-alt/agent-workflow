// RFC-061 PR-A T3 — projection rebuilder + consistency checker.
//
// Two entry points:
//
//   - `rebuildProjections(db)` — wipe all projection tables then replay
//     every event in `events` (ordered by id, which is monotonic) through
//     the applier. Used by daemon-restart recovery and by tests that want
//     a known clean projection state.
//
//   - `verifyProjectionConsistency(db, migrationsFolder)` — open a fresh
//     temp in-memory database, copy all `events` rows over, run rebuild
//     against it, snapshot the rebuilt projections, then compare against
//     the live projections. Returns a `ConsistencyReport`. Read-only on
//     the live DB.
//
// **Sync transaction body.** Same constraint as writeEvents — drizzle's
// bun-sqlite transaction is synchronous and async callbacks return
// before the body's writes finish. rebuildProjections runs everything
// inside one sync tx.

import { asc, eq } from 'drizzle-orm'

import { createInMemoryDb, type DbClient } from '../db/client'
import {
  attempts,
  events,
  logicalRuns,
  nodeOutputs,
  projectionMeta,
  suspensions,
  tasks,
  workflows,
} from '../db/schema'
import { type RawEvent, RawEventSchema } from '@agent-workflow/shared'

import { applyEvent, type DbOrTx } from './eventApplier'

export interface ConsistencyDivergence {
  table: 'logical_runs' | 'attempts' | 'node_outputs' | 'suspensions'
  kind: 'missing-in-projection' | 'extra-in-projection' | 'field-mismatch'
  key: string
  detail?: string
}

export interface ConsistencyReport {
  consistent: boolean
  divergences: ReadonlyArray<ConsistencyDivergence>
  eventCount: number
}

/**
 * Wipe + rebuild every projection table from the `events` log.
 * Returns the number of events replayed. The rebuild is transactional —
 * a partial failure rolls back to the prior projection state.
 */
export function rebuildProjections(db: DbClient): number {
  let replayedCount = 0
  db.transaction((tx) => {
    // Wipe projections in FK-respecting order.
    tx.delete(suspensions).run()
    tx.delete(attempts).run()
    tx.delete(nodeOutputs).run()
    tx.delete(logicalRuns).run()

    // Read all events ordered by id (monotonic ULID == insertion order).
    const rows = tx.select().from(events).orderBy(asc(events.id)).all()

    for (const raw of rows) {
      const parsed = RawEventSchema.parse(raw)
      applyEvent(tx, parsed)
      replayedCount += 1
    }

    // Advance cursor to the last replayed event.
    const lastId = rows[rows.length - 1]?.id ?? null
    const now = Date.now()
    tx.insert(projectionMeta)
      .values({ id: 1, lastProcessedEventId: lastId, rebuiltAt: now })
      .onConflictDoUpdate({
        target: projectionMeta.id,
        set: { lastProcessedEventId: lastId, rebuiltAt: now },
      })
      .run()
  })
  return replayedCount
}

/** Snapshot a single projection table's canonical form (key → projected fields). */
function snapshotProjections(db: DbOrTx) {
  const lrRows = db.select().from(logicalRuns).all() as Array<typeof logicalRuns.$inferSelect>
  const attRows = db.select().from(attempts).all() as Array<typeof attempts.$inferSelect>
  const outRows = db.select().from(nodeOutputs).all() as Array<typeof nodeOutputs.$inferSelect>
  const susRows = db.select().from(suspensions).all() as Array<typeof suspensions.$inferSelect>
  return {
    logicalRuns: canonicalizeLogicalRuns(lrRows),
    attempts: canonicalizeAttempts(attRows),
    nodeOutputs: canonicalizeNodeOutputs(outRows),
    suspensions: canonicalizeSuspensions(susRows),
  }
}

function canonicalizeLogicalRuns(rows: Array<typeof logicalRuns.$inferSelect>) {
  const m = new Map<string, ReturnType<typeof projectLogicalRun>>()
  for (const r of rows) {
    m.set(projectLogicalRunKey(r), projectLogicalRun(r))
  }
  return m
}

function projectLogicalRunKey(r: typeof logicalRuns.$inferSelect): string {
  return `${r.taskId}|${r.nodeId}|${r.loopIter}|${r.shardKey}|${r.iter}`
}

function projectLogicalRun(r: typeof logicalRuns.$inferSelect) {
  return {
    id: r.id,
    taskId: r.taskId,
    nodeId: r.nodeId,
    loopIter: r.loopIter,
    shardKey: r.shardKey,
    iter: r.iter,
    status: r.status,
  }
}

function canonicalizeAttempts(rows: Array<typeof attempts.$inferSelect>) {
  const m = new Map<string, ReturnType<typeof projectAttempt>>()
  for (const r of rows) {
    m.set(r.id, projectAttempt(r))
  }
  return m
}

function projectAttempt(r: typeof attempts.$inferSelect) {
  return {
    id: r.id,
    attemptSeq: r.attemptSeq,
    pid: r.pid,
    opencodeSessionId: r.opencodeSessionId,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    outcome: r.outcome,
    exitCode: r.exitCode,
    errorMessage: r.errorMessage,
    preSnapshot: r.preSnapshot,
  }
}

function canonicalizeNodeOutputs(rows: Array<typeof nodeOutputs.$inferSelect>) {
  const m = new Map<string, ReturnType<typeof projectNodeOutput>>()
  for (const r of rows) {
    const key = `${r.taskId}|${r.nodeId}|${r.loopIter}|${r.shardKey}|${r.iter}|${r.portName}`
    m.set(key, projectNodeOutput(r))
  }
  return m
}

function projectNodeOutput(r: typeof nodeOutputs.$inferSelect) {
  return {
    taskId: r.taskId,
    nodeId: r.nodeId,
    loopIter: r.loopIter,
    shardKey: r.shardKey,
    iter: r.iter,
    portName: r.portName,
    content: r.content,
  }
}

function canonicalizeSuspensions(rows: Array<typeof suspensions.$inferSelect>) {
  const m = new Map<string, ReturnType<typeof projectSuspension>>()
  for (const r of rows) {
    m.set(r.id, projectSuspension(r))
  }
  return m
}

function projectSuspension(r: typeof suspensions.$inferSelect) {
  return {
    id: r.id,
    signalKind: r.signalKind,
    awaitsActor: r.awaitsActor,
    payload: r.payload,
    resolvedAt: r.resolvedAt === null ? null : 'resolved',
  }
}

/**
 * Compare the live projections against a from-scratch rebuild done in a
 * separate temp in-memory database. Read-only on the live DB.
 *
 * Requires the migrations folder so the temp DB has the same schema. In
 * the daemon this is `~/.agent-workflow/migrations` (or the bundled path
 * inside the binary); tests pass their own path.
 */
export function verifyProjectionConsistency(
  db: DbClient,
  migrationsFolder: string,
): ConsistencyReport {
  // Snapshot live first (no writes anywhere).
  const live = snapshotProjections(db)

  // Pull all events and their referenced parent rows from live DB.
  const eventRows = db.select().from(events).orderBy(asc(events.id)).all() as Array<{
    id: string
    taskId: string
    ts: number
    kind: string
    nodeId: string | null
    loopIter: number | null
    shardKey: string | null
    iter: number | null
    attemptId: string | null
    parentEventId: string | null
    actor: string
    resolutionId: string | null
    payload: string
  }>
  const taskRows = db.select().from(tasks).all() as Array<typeof tasks.$inferSelect>
  const workflowRows = db.select().from(workflows).all() as Array<typeof workflows.$inferSelect>

  // Build a temp DB with the same schema; copy events + their FK parents.
  const tempDb = createInMemoryDb(migrationsFolder)
  tempDb.transaction((tx) => {
    // Copy FK parents.
    if (workflowRows.length > 0) {
      tx.insert(workflows).values(workflowRows).run()
    }
    if (taskRows.length > 0) {
      tx.insert(tasks).values(taskRows).run()
    }
    // Replay events through the applier (skipping the events INSERT to
    // avoid the events_no_update trigger; not needed for projection
    // comparison anyway).
    for (const raw of eventRows) {
      const parsed = RawEventSchema.parse(raw)
      applyEvent(tx, parsed)
    }
  })

  const rebuilt = snapshotProjections(tempDb)

  const divergences: ConsistencyDivergence[] = []
  divergences.push(...diffMap('logical_runs', live.logicalRuns, rebuilt.logicalRuns))
  divergences.push(...diffMap('attempts', live.attempts, rebuilt.attempts))
  divergences.push(...diffMap('node_outputs', live.nodeOutputs, rebuilt.nodeOutputs))
  divergences.push(...diffMap('suspensions', live.suspensions, rebuilt.suspensions))

  return {
    consistent: divergences.length === 0,
    divergences,
    eventCount: eventRows.length,
  }
}

function diffMap<V extends object>(
  table: ConsistencyDivergence['table'],
  live: Map<string, V>,
  rebuilt: Map<string, V>,
): ConsistencyDivergence[] {
  const out: ConsistencyDivergence[] = []
  for (const [k, v] of live) {
    const r = rebuilt.get(k)
    if (!r) {
      out.push({ table, kind: 'extra-in-projection', key: k })
      continue
    }
    const liveJson = JSON.stringify(v)
    const rebJson = JSON.stringify(r)
    if (liveJson !== rebJson) {
      out.push({
        table,
        kind: 'field-mismatch',
        key: k,
        detail: `live=${liveJson} rebuilt=${rebJson}`,
      })
    }
  }
  for (const [k] of rebuilt) {
    if (!live.has(k)) {
      out.push({ table, kind: 'missing-in-projection', key: k })
    }
  }
  return out
}

/**
 * Helper used by tests to do "apply this event sequence from scratch" —
 * wipes projections, then applies the given events in order. Does NOT
 * touch the events table itself; tests pass raw events directly.
 */
export function replayEventsToFreshProjections(
  db: DbClient,
  rawEvents: ReadonlyArray<RawEvent>,
): void {
  db.transaction((tx) => {
    tx.delete(suspensions).run()
    tx.delete(attempts).run()
    tx.delete(nodeOutputs).run()
    tx.delete(logicalRuns).run()
    for (const r of rawEvents) {
      applyEvent(tx, r)
    }
  })
}

/**
 * Read the projection cursor — used by daemon startup to decide between
 * incremental apply and full rebuild.
 */
export function readProjectionCursor(db: DbClient): string | null {
  const rows = db
    .select({ lastProcessedEventId: projectionMeta.lastProcessedEventId })
    .from(projectionMeta)
    .where(eq(projectionMeta.id, 1))
    .all()
  return rows[0]?.lastProcessedEventId ?? null
}
