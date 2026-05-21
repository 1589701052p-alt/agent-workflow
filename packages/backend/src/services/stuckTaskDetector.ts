// RFC-053 P-6 — stuck-task detector.
//
// Four rules (S1/S2/S3/S4); each looks at whether a task has been parked
// in a status for longer than its threshold AND the *evidence* matching
// that status is missing. Together: "stuck without explanation."
//
//   S1  task.status='awaiting_review' > 30 min, no pending doc_version
//   S2  task.status='awaiting_human'  > 30 min, no open clarify_session
//   S3  task.status='running'         > 30 min, no node_run still active
//   S4  task.status='pending'         > 5 min
//
// "30 min" for S1/S2/S3 is from the latest node_run_events for the task —
// if events are still landing we don't flag (the task is actively talking
// to opencode, not stuck). Falls back to tasks.startedAt when no events.
// S4 uses tasks.startedAt directly because pending tasks never emit events.
//
// Findings land in the same lifecycle_alerts table as PR-D's invariants
// (rule='S1'|'S2'|'S3'|'S4'); the shared reconcileLifecycleAlerts pass
// scoped to STUCK_RULES keeps the two writers from stepping on each
// other.
//
// Non-goal: this module does not "fix" stuck tasks. The UI surfaces them
// for an operator; remediation stays on the per-incident fixup script
// pattern that RFC-052 established (see scripts/fixup-rfc052-*).

import { and, eq, inArray, isNull, max } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifySessions, docVersions, nodeRunEvents, nodeRuns, tasks } from '@/db/schema'
import { createLogger } from '@/util/log'

import {
  reconcileLifecycleAlerts,
  STUCK_RULES,
  type LifecycleAlertFinding,
  type LifecycleAlertRow,
  type StuckRule,
} from './lifecycleInvariants'

const log = createLogger('lifecycle.stuck')

const MIN_MS = 60_000

/** Default freshness threshold for S1/S2/S3 — 30 minutes. */
export const DEFAULT_STUCK_THRESHOLD_MS = 30 * MIN_MS
/** Default S4 threshold — 5 minutes; pending tasks should be picked up
 *  by the scheduler in ms, not minutes. */
export const DEFAULT_PENDING_THRESHOLD_MS = 5 * MIN_MS

export interface RunStuckTaskDetectorArgs {
  db: DbClient
  /** Override Date.now() — used by tests. */
  now?: () => number
  /** Default 30 minutes; overridable for tests. */
  stuckThresholdMs?: number
  /** Default 5 minutes; overridable for tests. */
  pendingThresholdMs?: number
  /** Receives newly-detected / promoted alerts; wired in cli/start.ts. */
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
}

export interface RunStuckTaskDetectorResult {
  scanned: number
  newAlerts: number
  promotedAlerts: number
  resolvedAlerts: number
  openAlerts: LifecycleAlertRow[]
}

interface StuckCandidate {
  taskId: string
  status: string
  startedAt: number
}

async function loadCandidates(db: DbClient): Promise<StuckCandidate[]> {
  // Only non-terminal task statuses are candidates. Terminal tasks
  // (done/failed/canceled/interrupted) never "stick" in the operational
  // sense — they're a final state.
  const rows = await db
    .select({
      id: tasks.id,
      status: tasks.status,
      startedAt: tasks.startedAt,
    })
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        inArray(tasks.status, ['pending', 'running', 'awaiting_review', 'awaiting_human']),
      ),
    )
  return rows.map((r) => ({ taskId: r.id, status: r.status, startedAt: r.startedAt }))
}

/**
 * Returns the timestamp of the latest node_run_events row across any
 * node_run of `taskId`. Returns `null` when the task has none — e.g.
 * pending tasks that haven't spawned a runner yet.
 */
async function latestEventTsForTask(db: DbClient, taskId: string): Promise<number | null> {
  const row = (
    await db
      .select({ ts: max(nodeRunEvents.ts) })
      .from(nodeRunEvents)
      .innerJoin(nodeRuns, eq(nodeRuns.id, nodeRunEvents.nodeRunId))
      .where(eq(nodeRuns.taskId, taskId))
  )[0]
  if (row === undefined || row.ts === null) return null
  return row.ts
}

async function hasPendingDocVersion(db: DbClient, taskId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: docVersions.id })
      .from(docVersions)
      .where(and(eq(docVersions.taskId, taskId), eq(docVersions.decision, 'pending')))
      .limit(1)
  )[0]
  return row !== undefined
}

async function hasOpenClarifySession(db: DbClient, taskId: string): Promise<boolean> {
  const row = (
    await db
      .select({ id: clarifySessions.id })
      .from(clarifySessions)
      .where(and(eq(clarifySessions.taskId, taskId), eq(clarifySessions.status, 'awaiting_human')))
      .limit(1)
  )[0]
  return row !== undefined
}

const TERMINAL_NODE_RUN_STATUSES: readonly string[] = [
  'done',
  'failed',
  'canceled',
  'interrupted',
  'skipped',
  'exhausted',
]

interface NodeRunCounts {
  total: number
  terminal: number
  active: number
}

async function nodeRunCounts(db: DbClient, taskId: string): Promise<NodeRunCounts> {
  const rows = await db
    .select({ status: nodeRuns.status })
    .from(nodeRuns)
    .where(eq(nodeRuns.taskId, taskId))
  let terminal = 0
  for (const r of rows) {
    if (TERMINAL_NODE_RUN_STATUSES.includes(r.status)) terminal++
  }
  return { total: rows.length, terminal, active: rows.length - terminal }
}

interface StuckTaskFinding extends LifecycleAlertFinding {
  rule: StuckRule
}

async function checkOne(
  db: DbClient,
  c: StuckCandidate,
  now: number,
  stuckThresholdMs: number,
  pendingThresholdMs: number,
): Promise<StuckTaskFinding[]> {
  const out: StuckTaskFinding[] = []

  if (c.status === 'pending') {
    // S4: pending too long. No freshness gate (pending tasks emit no
    // events; the gate would never trigger).
    const pendingForMs = now - c.startedAt
    if (pendingForMs > pendingThresholdMs) {
      out.push({
        taskId: c.taskId,
        rule: 'S4',
        detail: {
          rule: 'S4',
          message: 'task pending too long without scheduler pickup',
          pendingForMs,
          thresholdMs: pendingThresholdMs,
        },
      })
    }
    return out
  }

  // S1/S2/S3 share the freshness gate: only flag tasks that have gone
  // quiet for `stuckThresholdMs`.
  const latestEventTs = await latestEventTsForTask(db, c.taskId)
  const lastActivityTs = latestEventTs ?? c.startedAt
  const inactiveForMs = now - lastActivityTs
  if (inactiveForMs <= stuckThresholdMs) return out // still active

  if (c.status === 'awaiting_review') {
    const hasPending = await hasPendingDocVersion(db, c.taskId)
    if (!hasPending) {
      out.push({
        taskId: c.taskId,
        rule: 'S1',
        detail: {
          rule: 'S1',
          message: 'task awaiting_review with no pending doc_version',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
        },
      })
    }
  } else if (c.status === 'awaiting_human') {
    const hasOpen = await hasOpenClarifySession(db, c.taskId)
    if (!hasOpen) {
      out.push({
        taskId: c.taskId,
        rule: 'S2',
        detail: {
          rule: 'S2',
          message: 'task awaiting_human with no open clarify_session',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
        },
      })
    }
  } else if (c.status === 'running') {
    const counts = await nodeRunCounts(db, c.taskId)
    // "All node_runs terminal" = no active rows AND at least one row exists
    // (an empty node_runs table for a running task is also wedge-y but
    // belongs to a different layer — scheduler bootstrap — so we require
    // counts.total > 0 here to be conservative).
    if (counts.total > 0 && counts.active === 0) {
      out.push({
        taskId: c.taskId,
        rule: 'S3',
        detail: {
          rule: 'S3',
          message: 'task running but every node_run is terminal',
          inactiveForMs,
          thresholdMs: stuckThresholdMs,
          totalRuns: counts.total,
          terminalRuns: counts.terminal,
        },
      })
    }
  }
  return out
}

export async function runStuckTaskDetector(
  args: RunStuckTaskDetectorArgs,
): Promise<RunStuckTaskDetectorResult> {
  const now = (args.now ?? Date.now)()
  const stuckMs = args.stuckThresholdMs ?? DEFAULT_STUCK_THRESHOLD_MS
  const pendingMs = args.pendingThresholdMs ?? DEFAULT_PENDING_THRESHOLD_MS
  const candidates = await loadCandidates(args.db)
  if (candidates.length === 0) {
    return { scanned: 0, newAlerts: 0, promotedAlerts: 0, resolvedAlerts: 0, openAlerts: [] }
  }
  const findings: StuckTaskFinding[] = []
  for (const c of candidates) {
    findings.push(...(await checkOne(args.db, c, now, stuckMs, pendingMs)))
  }
  const reconciled = await reconcileLifecycleAlerts({
    db: args.db,
    taskIds: candidates.map((c) => c.taskId),
    findings,
    now,
    ownedRules: STUCK_RULES,
    onAlert: args.onAlert,
  })
  log.info('scan complete', {
    scanned: candidates.length,
    findings: findings.length,
    newAlerts: reconciled.newAlerts,
    promotedAlerts: reconciled.promotedAlerts,
    resolvedAlerts: reconciled.resolvedAlerts,
  })
  if (reconciled.promotedAlerts > 0 || reconciled.openAlerts.some((a) => a.severity === 'error')) {
    log.error('stuck tasks detected', {
      open: reconciled.openAlerts.length,
      errorCount: reconciled.openAlerts.filter((a) => a.severity === 'error').length,
    })
  }
  return { scanned: candidates.length, ...reconciled }
}

/**
 * Run every `intervalMs` (default 5 min). No boot delay separate from
 * the lifecycle invariants ticker — stuck detection can wait the full
 * first interval since the freshness gate already requires
 * `> stuckThresholdMs` of inactivity, and any historic stuck task will
 * still show up on the second tick.
 */
export function startStuckTaskDetectorLoop(opts: {
  db: DbClient
  onAlert?: (row: LifecycleAlertRow, transition: 'new' | 'promoted') => void
  intervalMs?: number
}): { stop: () => void } {
  const interval = opts.intervalMs ?? 5 * MIN_MS
  let running = false
  const safeRun = (): void => {
    if (running) return
    running = true
    void runStuckTaskDetector({ db: opts.db, onAlert: opts.onAlert })
      .catch((err: unknown) => {
        log.error('scan failed', { error: err instanceof Error ? err.message : String(err) })
      })
      .finally(() => {
        running = false
      })
  }
  const handle = setInterval(safeRun, interval)
  return { stop: () => clearInterval(handle) }
}
