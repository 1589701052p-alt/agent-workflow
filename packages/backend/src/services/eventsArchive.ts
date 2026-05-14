// P-5-01: hourly archival of node_run_events to JSONL on disk.
//
// Scans node_run_events; any node_run whose row count exceeds
// `perNodeRunRows` has its oldest rows dumped to
// `${logsDir}/{taskId}/{nodeRunId}.jsonl` (append-only) and deleted from
// the DB. After per-group passes, if the total row count still exceeds
// `globalRows`, the globally-oldest rows are archived in the same way
// until the total fits.
//
// The events endpoint (getNodeRunEvents) transparently falls back to the
// JSONL file, so the UI sees a single seamless stream.

import { asc, count, eq, gt, inArray } from 'drizzle-orm'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Config } from '@agent-workflow/shared'
import type { DbClient } from '@/db/client'
import { nodeRunEvents, nodeRuns } from '@/db/schema'
import { createLogger } from '@/util/log'

const log = createLogger('events-archive')

const HOUR_MS = 60 * 60 * 1000

export interface ArchiveRunResult {
  perGroupArchived: number
  globalArchived: number
  files: string[]
}

/**
 * One archival pass. Returns counters for tests / log lines.
 */
export async function archiveEvents(
  db: DbClient,
  config: Pick<Config, 'eventsArchiveThresholds'>,
  logsDir: string,
): Promise<ArchiveRunResult> {
  const { perNodeRunRows, globalRows } = config.eventsArchiveThresholds
  const result: ArchiveRunResult = { perGroupArchived: 0, globalArchived: 0, files: [] }
  const touched = new Set<string>()

  // --- Per-node-run pass --------------------------------------------------
  const groups = await db
    .select({ nodeRunId: nodeRunEvents.nodeRunId, n: count(nodeRunEvents.id) })
    .from(nodeRunEvents)
    .groupBy(nodeRunEvents.nodeRunId)
    .having(gt(count(nodeRunEvents.id), perNodeRunRows))

  for (const g of groups) {
    const toDrop = g.n - perNodeRunRows
    const file = await archiveOldestForNode(db, g.nodeRunId, toDrop, logsDir)
    if (file !== null) {
      result.perGroupArchived += toDrop
      touched.add(file)
    }
  }

  // --- Global pass --------------------------------------------------------
  const totalRow = await db.select({ n: count(nodeRunEvents.id) }).from(nodeRunEvents)
  let total = totalRow[0]?.n ?? 0
  while (total > globalRows) {
    // Find the oldest event row, then archive its node_run's oldest chunk.
    const oldest = await db
      .select({ id: nodeRunEvents.id, nodeRunId: nodeRunEvents.nodeRunId })
      .from(nodeRunEvents)
      .orderBy(asc(nodeRunEvents.id))
      .limit(1)
    if (oldest.length === 0) break
    const head = oldest[0]!
    const overflow = total - globalRows
    // Don't drop more than this node_run actually owns at the head.
    const ownCount = await db
      .select({ n: count(nodeRunEvents.id) })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, head.nodeRunId))
    const own = ownCount[0]?.n ?? 0
    const toDrop = Math.min(overflow, own)
    if (toDrop <= 0) break
    const file = await archiveOldestForNode(db, head.nodeRunId, toDrop, logsDir)
    if (file === null) break
    result.globalArchived += toDrop
    touched.add(file)
    total -= toDrop
  }

  result.files = [...touched]
  if (result.perGroupArchived > 0 || result.globalArchived > 0) {
    log.info('archived events', {
      perGroupArchived: result.perGroupArchived,
      globalArchived: result.globalArchived,
      files: result.files.length,
    })
  }
  return result
}

/**
 * Archive the oldest `count` rows for one node_run. Returns the JSONL file
 * path that was written to (or null if the node_run is unknown / orphaned).
 */
async function archiveOldestForNode(
  db: DbClient,
  nodeRunId: string,
  toDrop: number,
  logsDir: string,
): Promise<string | null> {
  if (toDrop <= 0) return null
  const owner = await db
    .select({ taskId: nodeRuns.taskId })
    .from(nodeRuns)
    .where(eq(nodeRuns.id, nodeRunId))
    .limit(1)
  const taskId = owner[0]?.taskId
  if (taskId === undefined) {
    // Orphan event rows — delete them so they don't block the global cap.
    const orphanRows = await db
      .select({ id: nodeRunEvents.id })
      .from(nodeRunEvents)
      .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
      .orderBy(asc(nodeRunEvents.id))
      .limit(toDrop)
    if (orphanRows.length > 0) {
      await db.delete(nodeRunEvents).where(
        inArray(
          nodeRunEvents.id,
          orphanRows.map((r) => r.id),
        ),
      )
    }
    return null
  }

  const rows = await db
    .select()
    .from(nodeRunEvents)
    .where(eq(nodeRunEvents.nodeRunId, nodeRunId))
    .orderBy(asc(nodeRunEvents.id))
    .limit(toDrop)
  if (rows.length === 0) return null

  const file = jsonlPath(logsDir, taskId, nodeRunId)
  mkdirSync(dirname(file), { recursive: true })
  let buf = ''
  for (const r of rows) {
    buf += JSON.stringify({ id: r.id, ts: r.ts, kind: r.kind, payload: r.payload }) + '\n'
  }
  appendFileSync(file, buf, 'utf-8')

  await db.delete(nodeRunEvents).where(
    inArray(
      nodeRunEvents.id,
      rows.map((r) => r.id),
    ),
  )
  return file
}

/**
 * Read archived JSONL events (id > since) up to `limit` rows. Returns []
 * if the file does not exist. The `payload` field is the raw stored string
 * (matching the DB column) — callers parse it themselves so we don't lose
 * the original bytes for stdout-style concatenation.
 */
export async function readArchivedEvents(
  logsDir: string,
  taskId: string,
  nodeRunId: string,
  since: number,
  limit: number,
): Promise<Array<{ id: number; ts: number; kind: string; payload: string }>> {
  const file = jsonlPath(logsDir, taskId, nodeRunId)
  if (!existsSync(file)) return []
  const text = await Bun.file(file).text()
  const out: Array<{ id: number; ts: number; kind: string; payload: string }> = []
  let cursor = 0
  while (cursor < text.length && out.length < limit) {
    const nl = text.indexOf('\n', cursor)
    const end = nl === -1 ? text.length : nl
    const line = text.slice(cursor, end)
    cursor = end + 1
    if (line === '') continue
    try {
      const obj = JSON.parse(line) as {
        id: number
        ts: number
        kind: string
        payload: string
      }
      if (obj.id <= since) continue
      out.push({ id: obj.id, ts: obj.ts, kind: obj.kind, payload: obj.payload })
    } catch {
      // skip corrupt line
    }
  }
  return out
}

function jsonlPath(logsDir: string, taskId: string, nodeRunId: string): string {
  return join(logsDir, taskId, `${nodeRunId}.jsonl`)
}

/**
 * Start the hourly archive ticker. `loadConfig` is called each tick so
 * config changes apply without restart, matching worktree-GC's pattern.
 */
export function startEventsArchiver(
  db: DbClient,
  loadConfig: () => Pick<Config, 'eventsArchiveThresholds'>,
  logsDir: string,
  intervalMs: number = HOUR_MS,
): { stop: () => void } {
  let running = false
  const handle = setInterval(() => {
    if (running) return
    running = true
    archiveEvents(db, loadConfig(), logsDir)
      .catch((err: unknown) => {
        log.error('archiveEvents failed', {
          error: err instanceof Error ? err.message : String(err),
        })
      })
      .finally(() => {
        running = false
      })
  }, intervalMs)
  return { stop: () => clearInterval(handle) }
}
