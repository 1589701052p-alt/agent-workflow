// RFC-159 — scheduled-task CRUD + fire logic.
//
// Shape mirrors services/mcp.ts (DB is source of truth; JSON columns marshaled
// at this boundary + re-validated with Zod on read). The launch gate
// (assertWorkflowLaunchable) runs at CREATE/UPDATE time AND again at fire time —
// access can be revoked in between (design.md §3/§5, R2-b/R3-1).
import type {
  CreateScheduledTask,
  ScheduledTask,
  ScheduleSpec,
  StartTask,
  UpdateScheduledTask,
} from '@agent-workflow/shared'
import {
  computeNextRunAt,
  ScheduledTaskSchema,
  ScheduleSpecSchema,
  StartTaskSchema,
  wallClockAt,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { scheduledTasks, users } from '@/db/schema'
import { assertWorkflowLaunchable } from '@/services/taskLaunchGate'
import { NotFoundError, ValidationError } from '@/util/errors'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'

/** Injected launch — `(body) => startTask(body, deps)`, closed over owner + scheduledTaskId. */
export type ScheduleLaunch = (payload: StartTask) => Promise<{ id: string }>
export type BuildScheduleLaunch = (ownerUserId: string, scheduledTaskId: string) => ScheduleLaunch

type Row = typeof scheduledTasks.$inferSelect
type LaunchableWorkflow = Awaited<ReturnType<typeof assertWorkflowLaunchable>>

function rowToScheduledTask(row: Row): ScheduledTask {
  const parsed = ScheduledTaskSchema.safeParse({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    launchPayload: JSON.parse(row.launchPayload),
    scheduleSpec: JSON.parse(row.scheduleSpec),
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    lastTaskId: row.lastTaskId,
    consecutiveFailures: row.consecutiveFailures,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })
  if (!parsed.success) {
    throw new ValidationError(
      'scheduled-task-row-corrupt',
      `scheduled task '${row.id}' row is corrupt`,
      { issues: parsed.error.issues },
    )
  }
  return parsed.data
}

/** RFC-159: reject workflows that REQUIRE a blob-upload input (can't be replayed). */
function assertNoRequiredUploadInput(wf: LaunchableWorkflow): void {
  const requiresUpload = wf.definition.inputs.some(
    (i) => i.kind === 'upload' && i.required === true,
  )
  if (requiresUpload) {
    throw new ValidationError(
      'scheduled-task-upload-required',
      `workflow '${wf.id}' has a required file-upload input, which a scheduled task cannot supply`,
    )
  }
}

export async function listScheduledTasks(db: DbClient): Promise<ScheduledTask[]> {
  const rows = await db.select().from(scheduledTasks)
  return rows.map(rowToScheduledTask)
}

export async function getScheduledTask(db: DbClient, id: string): Promise<ScheduledTask | null> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1)
  return rows[0] ? rowToScheduledTask(rows[0]) : null
}

/** Raw DB row (unparsed JSON columns) — `fireSchedule` / run-now need it. */
export async function getScheduledTaskRow(db: DbClient, id: string): Promise<Row | null> {
  const rows = await db.select().from(scheduledTasks).where(eq(scheduledTasks.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createScheduledTask(
  db: DbClient,
  input: CreateScheduledTask,
  opts: { actor: Actor },
): Promise<ScheduledTask> {
  const body = StartTaskSchema.parse(input.launchPayload) // guarantee replayable
  // Create-time gate (R2-b): invisible / built-in / deleted workflow → 404 now,
  // not silently at fire time. Fire still re-checks (access can be revoked).
  const wf = await assertWorkflowLaunchable(db, opts.actor, body.workflowId)
  assertNoRequiredUploadInput(wf)
  const spec = ScheduleSpecSchema.parse(input.scheduleSpec)
  const now = Date.now()
  const id = ulid()
  await db.insert(scheduledTasks).values({
    id,
    name: input.name,
    ownerUserId: opts.actor.user.id,
    launchPayload: JSON.stringify(body),
    scheduleSpec: JSON.stringify(spec),
    enabled: input.enabled,
    nextRunAt: input.enabled ? computeNextRunAt(spec, now, now) : null,
    consecutiveFailures: 0,
    createdAt: now,
    updatedAt: now,
  })
  const created = await getScheduledTask(db, id)
  if (created === null) throw new Error('scheduled task disappeared right after insert')
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.created',
    id: created.id,
    ownerUserId: created.ownerUserId,
  })
  return created
}

export async function updateScheduledTask(
  db: DbClient,
  id: string,
  patch: UpdateScheduledTask,
  opts: { actor: Actor },
): Promise<ScheduledTask> {
  const existing = await getScheduledTask(db, id)
  if (existing === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  const body: StartTask =
    patch.launchPayload !== undefined
      ? StartTaskSchema.parse(patch.launchPayload)
      : existing.launchPayload
  const spec: ScheduleSpec =
    patch.scheduleSpec !== undefined
      ? ScheduleSpecSchema.parse(patch.scheduleSpec)
      : existing.scheduleSpec
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled

  // R3-1: re-gate whenever the RESULT is enabled (spec-only / re-enable / payload
  // change). Skip when the result is disabled so a user can still stop/clean up a
  // schedule whose workflow vanished.
  if (enabled) {
    const wf = await assertWorkflowLaunchable(db, opts.actor, body.workflowId)
    assertNoRequiredUploadInput(wf)
  }

  const now = Date.now()
  const set: Partial<typeof scheduledTasks.$inferInsert> = { updatedAt: now }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.launchPayload !== undefined) set.launchPayload = JSON.stringify(body)
  if (patch.scheduleSpec !== undefined) set.scheduleSpec = JSON.stringify(spec)
  if (patch.enabled !== undefined) set.enabled = enabled
  if (!enabled) {
    set.nextRunAt = null
  } else if (patch.scheduleSpec !== undefined || (enabled && !existing.enabled)) {
    set.nextRunAt = computeNextRunAt(spec, now, now)
    set.consecutiveFailures = 0
  }
  await db.update(scheduledTasks).set(set).where(eq(scheduledTasks.id, id))
  const updated = await getScheduledTask(db, id)
  if (updated === null) throw new Error('scheduled task disappeared right after update')
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.updated',
    id: updated.id,
    ownerUserId: updated.ownerUserId,
  })
  return updated
}

export async function deleteScheduledTask(db: DbClient, id: string): Promise<void> {
  const existing = await getScheduledTask(db, id)
  if (existing === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  await db.delete(scheduledTasks).where(eq(scheduledTasks.id, id))
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.deleted',
    id,
    ownerUserId: existing.ownerUserId,
  })
}

/** `${base} · <fire time>` — disambiguates the many tasks a recurring schedule spawns. ≤255. */
export function decorateTaskName(base: string, spec: ScheduleSpec, now: number): string {
  const tz = spec.kind === 'interval' ? 'UTC' : spec.timezone
  const wc = wallClockAt(now, tz)
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const suffix = ` · ${wc.year}-${p2(wc.month)}-${p2(wc.day)} ${p2(wc.hour)}:${p2(wc.minute)}`
  const room = Math.max(0, 255 - suffix.length)
  return `${base.length > room ? base.slice(0, room) : base}${suffix}`
}

/**
 * Fire one schedule: synthesize the owner actor, re-check launchability (RFC-099
 * D3 — access may have been revoked since create), then replay via the injected
 * launch (which stamps tasks.scheduled_task_id). Throws on any pre-launch failure
 * (owner inactive / workflow gone / invisible / built-in); the caller records it.
 */
export async function fireSchedule(
  db: DbClient,
  row: Row,
  buildLaunch: BuildScheduleLaunch,
  now: number,
): Promise<{ taskId: string }> {
  const body = StartTaskSchema.parse(JSON.parse(row.launchPayload))
  const spec = ScheduleSpecSchema.parse(JSON.parse(row.scheduleSpec))
  const bodyWithName: StartTask = { ...body, name: decorateTaskName(body.name, spec, now) }

  const owner = (await db.select().from(users).where(eq(users.id, row.ownerUserId)).limit(1))[0]
  if (!owner || owner.status !== 'active') {
    throw new ValidationError('owner-inactive', `owner '${row.ownerUserId}' is not an active user`)
  }
  const actor: Actor = buildActor({
    user: {
      id: owner.id,
      username: owner.username,
      displayName: owner.displayName,
      role: owner.role,
      status: owner.status,
    },
    source: 'daemon',
  })
  await assertWorkflowLaunchable(db, actor, bodyWithName.workflowId)

  const launch = buildLaunch(row.ownerUserId, row.id)
  const task = await launch(bodyWithName)
  return { taskId: task.id }
}

/**
 * Manual "run now" (RFC-159 T7): fire immediately via the SAME `fireSchedule` path
 * (owner actor + launchability re-check), but deliberately leave the schedule row's
 * automated-cadence state untouched — `next_run_at` / `last_*` / `consecutive_failures`
 * stay reserved for real scheduled fires, so a manual test-run never advances the clock
 * nor auto-disables the schedule. The launched task is stamped `scheduled_task_id`
 * (shows in run history); a `scheduled.fired` broadcast refreshes history for all
 * viewers. Throws (→ HTTP error) on any launch failure, exactly like `fireSchedule`.
 */
export async function runScheduleNow(
  db: DbClient,
  id: string,
  buildLaunch: BuildScheduleLaunch,
): Promise<{ taskId: string }> {
  const row = await getScheduledTaskRow(db, id)
  if (row === null) {
    throw new NotFoundError('scheduled-task-not-found', `scheduled task '${id}' not found`)
  }
  const result = await fireSchedule(db, row, buildLaunch, Date.now())
  scheduledTaskBroadcaster.broadcast(SCHEDULED_TASK_CHANNEL, {
    type: 'scheduled.fired',
    id: row.id,
    ownerUserId: row.ownerUserId,
  })
  return result
}
