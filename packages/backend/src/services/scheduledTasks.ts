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
  rejectRetiredStartTaskKeys,
  ScheduledTaskSchema,
  ScheduleSpecSchema,
  StartTaskSchema,
  wallClockAt,
} from '@agent-workflow/shared'
import { eq } from 'drizzle-orm'
import { existsSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ulid } from 'ulid'

import { buildActor, type Actor } from '@/auth/actor'
import type { DbClient } from '@/db/client'
import { scheduledTasks, users } from '@/db/schema'
import { assertWorkflowLaunchable } from '@/services/taskLaunchGate'
import { NotFoundError, ValidationError } from '@/util/errors'
import { runGit } from '@/util/git'
import { SCHEDULED_TASK_CHANNEL, scheduledTaskBroadcaster } from '@/ws/broadcaster'

/** Injected launch — `(body) => startTask(body, deps)`, closed over owner + scheduledTaskId. */
export type ScheduleLaunch = (payload: StartTask) => Promise<{ id: string }>
export type BuildScheduleLaunch = (ownerUserId: string, scheduledTaskId: string) => ScheduleLaunch

type Row = typeof scheduledTasks.$inferSelect
type LaunchableWorkflow = Awaited<ReturnType<typeof assertWorkflowLaunchable>>

/**
 * RFC-165 (F18/N3): per-field tolerant JSON parsing. One legacy / corrupt row
 * must never take down the whole list (the old mapper threw
 * `scheduled-task-row-corrupt` for ANY parse failure). Three states per field:
 * ok(value) / legacy(null + migrationNeeded — retired path-mode keys the user
 * can repair by re-saving) / degraded(null + migrationError). Auth, delete,
 * disable and name-only edits read only the plain columns, so they keep
 * working on broken rows.
 */
function parseJsonField<T>(
  raw: string,
  schema: {
    safeParse: (
      v: unknown,
    ) =>
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ message: string }> } }
  },
  isLegacyShape?: (json: unknown) => boolean,
): { value: T | null; legacy: boolean; error: string | null } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    return { value: null, legacy: false, error: `invalid-json: ${(err as Error).message}` }
  }
  const parsed = schema.safeParse(json)
  if (parsed.success) return { value: parsed.data, legacy: false, error: null }
  if (isLegacyShape?.(json) === true) return { value: null, legacy: true, error: null }
  return {
    value: null,
    legacy: false,
    error: `invalid-shape: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
  }
}

function rowToScheduledTask(row: Row): ScheduledTask {
  const payload = parseJsonField(
    row.launchPayload,
    StartTaskSchema,
    (json) => rejectRetiredStartTaskKeys(json) !== null,
  )
  const spec = parseJsonField(row.scheduleSpec, ScheduleSpecSchema)
  const hasError = payload.error !== null || spec.error !== null
  // RFC-165 (implementation-gate P2): even a degraded payload usually still
  // carries a readable workflowId — surface it so the detail page can keep
  // the edit-config (full-repair) entry routable. Corrupt JSON → null.
  let workflowIdHint: string | null = null
  try {
    const raw: unknown = JSON.parse(row.launchPayload)
    if (typeof raw === 'object' && raw !== null) {
      const wf = (raw as Record<string, unknown>)['workflowId']
      if (typeof wf === 'string' && wf.length > 0) workflowIdHint = wf
    }
  } catch {
    /* corrupt JSON — no hint */
  }
  const parsed = ScheduledTaskSchema.safeParse({
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    launchPayload: payload.value,
    scheduleSpec: spec.value,
    migrationNeeded: payload.legacy,
    migrationError: hasError ? { launchPayload: payload.error, scheduleSpec: spec.error } : null,
    launchPayloadWorkflowId: workflowIdHint,
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
    // Only non-JSON column corruption lands here now (e.g. a hand-edited enum)
    // — genuinely exceptional, keep the loud failure.
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
  // RFC-165 (N3, narrowed per implementation-gate review): a legacy/degraded
  // row has null JSON fields — a partial PUT that keeps such a field would
  // persist garbage, so repair (a full replacement value) is required ONLY
  // when this update actually CONSUMES the degraded field: the result being
  // enabled needs a valid payload (workflow gate) and a valid spec
  // (next_run_at). Plain rename / disable of a degraded row must stay
  // possible — otherwise a corrupt schedule can't even be stopped.
  const patchedPayload =
    patch.launchPayload !== undefined
      ? StartTaskSchema.parse(patch.launchPayload)
      : existing.launchPayload
  const patchedSpec =
    patch.scheduleSpec !== undefined
      ? ScheduleSpecSchema.parse(patch.scheduleSpec)
      : existing.scheduleSpec
  const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled

  if (enabled) {
    if (patchedPayload === null) {
      throw new ValidationError(
        'scheduled-task-needs-repair',
        `scheduled task '${id}' has an unreadable launchPayload — supply a full launchPayload to repair it`,
      )
    }
    if (patchedSpec === null) {
      throw new ValidationError(
        'scheduled-task-needs-repair',
        `scheduled task '${id}' has an unreadable scheduleSpec — supply a full scheduleSpec to repair it`,
      )
    }
  }

  // R3-1: re-gate whenever the RESULT is enabled (spec-only / re-enable / payload
  // change). Skip when the result is disabled so a user can still stop/clean up a
  // schedule whose workflow vanished.
  if (enabled && patchedPayload !== null) {
    const wf = await assertWorkflowLaunchable(db, opts.actor, patchedPayload.workflowId)
    assertNoRequiredUploadInput(wf)
  }

  const now = Date.now()
  const set: Partial<typeof scheduledTasks.$inferInsert> = { updatedAt: now }
  if (patch.name !== undefined) set.name = patch.name
  if (patch.launchPayload !== undefined && patchedPayload !== null) {
    set.launchPayload = JSON.stringify(patchedPayload)
    // A successful full repair also clears the RFC-165 migration lastError
    // breadcrumb (best-effort UX; harmless when it was never set).
    if (existing.launchPayload === null || existing.migrationNeeded) set.lastError = null
  }
  if (patch.scheduleSpec !== undefined && patchedSpec !== null) {
    set.scheduleSpec = JSON.stringify(patchedSpec)
  }
  if (patch.enabled !== undefined) set.enabled = enabled
  if (!enabled) {
    set.nextRunAt = null
  } else if (patch.scheduleSpec !== undefined || (enabled && !existing.enabled)) {
    // enabled ⇒ patchedSpec non-null (guarded above).
    set.nextRunAt = computeNextRunAt(patchedSpec as ScheduleSpec, now, now)
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
/**
 * RFC-165 (§9): one-shot boot healer — rewrite stored path-mode launch
 * payloads to their faithful `file://` form. Runs after migrations and BEFORE
 * the HTTP server starts serving (and before the scheduler ticker), so both
 * read paths and fires only ever see healed rows.
 *
 * Strategy (F19): `pathToFileURL(realpath(dir))` preserves the LOCAL repo
 * exactly (unpushed branches included — the cached mirror clones from the
 * path itself), unlike an origin-URL rewrite which drops anything unpushed.
 *   * dir exists and is a git repo → rewrite `{repoPath, baseBranch}` →
 *     `{repoUrl: file://…, ref: baseBranch}` (top level and each repos[] row);
 *     drop `fetchBeforeLaunch` (false/absent only). Git-ness is probed via
 *     `git rev-parse --git-dir` (a bare repo / worktree subdir has no `.git`
 *     child yet was perfectly launchable in path mode).
 *   * `fetchBeforeLaunch: true`     → DISABLE + lastError
 *     'rfc165-fetch-semantic-review' — the old semantics ("refresh the local
 *     repo's origin/* before launch") have no file:// equivalent; the user
 *     must confirm a URL choice and re-save. Never silently converted.
 *   * `baseBranch` naming a REMOTE-TRACKING ref (`origin/x`, `refs/remotes/…`)
 *     → DISABLE + lastError 'rfc165-remote-tracking-ref'. In the file clone
 *     that string resolves against the CLONE's own origin (= the source's
 *     local branches), not the source's refs/remotes/* — silently launching
 *     a different commit is exactly what F19 forbids.
 *   * dir missing / not a git repo → DISABLE + lastError
 *     'rfc165-local-path-retired'.
 * Idempotent: healed payloads carry no `repoPath`; already-disabled rfc165-*
 * rows are skipped.
 */
export async function healScheduledLaunchPayloads(
  db: DbClient,
): Promise<{ scanned: number; converted: number; disabled: number }> {
  const rows = await db.select().from(scheduledTasks)
  let converted = 0
  let disabled = 0
  const now = Date.now()

  const disable = async (row: Row, error: string): Promise<void> => {
    await db
      .update(scheduledTasks)
      .set({ enabled: false, nextRunAt: null, lastError: error, updatedAt: now })
      .where(eq(scheduledTasks.id, row.id))
    disabled += 1
  }
  // Bare repos / worktree subdirs have no `.git` child — probe with git
  // itself (P2 review fix; the old `.git`-child check disabled runnable rows).
  const isGitDir = async (p: string): Promise<boolean> => {
    if (!existsSync(p)) return false
    try {
      return (await runGit(p, ['rev-parse', '--git-dir'])).exitCode === 0
    } catch {
      return false
    }
  }
  const toFileUrl = (p: string): string => pathToFileURL(realpathSync(p)).href
  // A remote-tracking ref cannot be carried into the file clone faithfully —
  // the clone's `origin/x` points at the SOURCE's local x, not the source's
  // own refs/remotes/origin/x (P1 review fix: disable instead of drifting).
  const isRemoteTrackingRef = (ref: string): boolean =>
    ref.startsWith('origin/') || ref.startsWith('refs/remotes/') || ref.startsWith('remotes/')

  for (const row of rows) {
    if (!row.enabled && (row.lastError ?? '').startsWith('rfc165-')) continue
    let payload: unknown
    try {
      payload = JSON.parse(row.launchPayload)
    } catch {
      continue // corrupt JSON → tolerant read surfaces it; not a path-heal target
    }
    if (typeof payload !== 'object' || payload === null) continue
    if (rejectRetiredStartTaskKeys(payload) === null) continue // already v2-clean
    const body = payload as Record<string, unknown>

    if (body['fetchBeforeLaunch'] === true) {
      await disable(
        row,
        'rfc165-fetch-semantic-review: fetchBeforeLaunch has no file:// equivalent — pick a repo source and re-save',
      )
      continue
    }

    const paths: string[] = []
    if (typeof body['repoPath'] === 'string') paths.push(body['repoPath'] as string)
    const repos = Array.isArray(body['repos'])
      ? (body['repos'] as Array<Record<string, unknown>>)
      : []
    for (const r of repos) {
      if (r !== null && typeof r === 'object' && typeof r['repoPath'] === 'string') {
        paths.push(r['repoPath'] as string)
      }
    }
    if (paths.length === 0) {
      // Retired keys present but no path value (e.g. stray baseBranch) — just
      // strip them so the payload becomes v2-clean.
      delete body['baseBranch']
      delete body['fetchBeforeLaunch']
      await db
        .update(scheduledTasks)
        .set({ launchPayload: JSON.stringify(body), updatedAt: now })
        .where(eq(scheduledTasks.id, row.id))
      converted += 1
      continue
    }
    let missing: string | undefined
    for (const p of paths) {
      if (!(await isGitDir(p))) {
        missing = p
        break
      }
    }
    if (missing !== undefined) {
      await disable(row, `rfc165-local-path-retired: ${missing}`)
      continue
    }
    // Collect every baseBranch the rewrite would carry into `ref` — a
    // remote-tracking form cannot survive the clone faithfully.
    const refs: string[] = []
    if (typeof body['baseBranch'] === 'string') refs.push(body['baseBranch'] as string)
    for (const r of repos) {
      if (r !== null && typeof r === 'object' && typeof r['baseBranch'] === 'string') {
        refs.push(r['baseBranch'] as string)
      }
    }
    const remoteRef = refs.find((r) => isRemoteTrackingRef(r))
    if (remoteRef !== undefined) {
      await disable(
        row,
        `rfc165-remote-tracking-ref: baseBranch '${remoteRef}' names a remote-tracking ref — pick a concrete branch/URL and re-save`,
      )
      continue
    }

    if (typeof body['repoPath'] === 'string') {
      body['repoUrl'] = toFileUrl(body['repoPath'] as string)
      if (typeof body['baseBranch'] === 'string') body['ref'] = body['baseBranch']
      delete body['repoPath']
      delete body['baseBranch']
    }
    for (const r of repos) {
      if (r === null || typeof r !== 'object') continue
      if (typeof r['repoPath'] === 'string') {
        r['repoUrl'] = toFileUrl(r['repoPath'] as string)
        if (typeof r['baseBranch'] === 'string') r['ref'] = r['baseBranch']
        delete r['repoPath']
        delete r['baseBranch']
      }
    }
    delete body['fetchBeforeLaunch']

    await db
      .update(scheduledTasks)
      .set({ launchPayload: JSON.stringify(body), updatedAt: now })
      .where(eq(scheduledTasks.id, row.id))
    converted += 1
  }
  return { scanned: rows.length, converted, disabled }
}

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
