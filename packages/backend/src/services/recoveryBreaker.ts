// RFC-108 T11 (AR-09) — auto-recovery circuit-breaker / quarantine.
//
// A task that deterministically crashes on every auto-resume / auto-repair would,
// the moment those loops turn on, be re-driven forever — burning real LLM cost +
// process handles each cycle. This bounds that: per-task rolling-window attempt
// accounting; after `maxPerWindow` attempts the task is QUARANTINED
// (`auto_recovery_suspended = 1`), excluding it from BOTH auto loops until a
// human clears it with one action. The quarantine flag is a SOFT flag (never a
// terminal status); the persistent recovery_events row makes the trip auditable.

import { eq } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { tasks } from '@/db/schema'
import { recordRecoveryEvent } from '@/services/recovery'

export interface BreakerConfig {
  maxPerWindow: number
  windowMs: number
}

/** Is the task currently quarantined (excluded from the auto loops)? */
export async function isAutoRecoverySuspended(db: DbClient, taskId: string): Promise<boolean> {
  const rows = await db
    .select({ s: tasks.autoRecoverySuspended })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  return (rows[0]?.s ?? 0) === 1
}

/**
 * Record an auto-recovery attempt against the rolling window and, if it pushes
 * the count OVER `maxPerWindow`, quarantine the task. Callers (the auto loops)
 * call this BEFORE acting and must NOT act when `suspended` is returned true.
 * Returns the post-update {suspended, attempts}.
 */
export async function recordAutoRecoveryAttempt(
  db: DbClient,
  taskId: string,
  cfg: BreakerConfig,
  now: number = Date.now(),
): Promise<{ suspended: boolean; attempts: number }> {
  const rows = await db
    .select({
      attempts: tasks.autoRecoveryAttempts,
      windowStart: tasks.autoRecoveryWindowStartedAt,
      suspended: tasks.autoRecoverySuspended,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1)
  const row = rows[0]
  if (row === undefined) return { suspended: false, attempts: 0 }
  if (row.suspended === 1) return { suspended: true, attempts: row.attempts }

  let windowStart = row.windowStart
  let attempts: number
  if (windowStart === null || now - windowStart >= cfg.windowMs) {
    windowStart = now
    attempts = 1
  } else {
    attempts = row.attempts + 1
  }
  const suspended = attempts > cfg.maxPerWindow
  await db
    .update(tasks)
    .set({
      autoRecoveryAttempts: attempts,
      autoRecoveryWindowStartedAt: windowStart,
      autoRecoverySuspended: suspended ? 1 : 0,
    })
    .where(eq(tasks.id, taskId))
  if (suspended) {
    await recordRecoveryEvent(db, {
      taskId,
      kind: 'quarantine',
      reason: `auto-recovery attempts ${attempts} exceeded ${cfg.maxPerWindow} per ${cfg.windowMs}ms window`,
      after: { autoRecoverySuspended: true, attempts },
      now,
    })
  }
  return { suspended, attempts }
}

/** Human one-click clear — resets the breaker so the auto loops may retry. */
export async function clearAutoRecoverySuspension(db: DbClient, taskId: string): Promise<void> {
  await db
    .update(tasks)
    .set({
      autoRecoverySuspended: 0,
      autoRecoveryAttempts: 0,
      autoRecoveryWindowStartedAt: null,
    })
    .where(eq(tasks.id, taskId))
}
