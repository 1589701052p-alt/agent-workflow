// RFC-057 — S4 repair options.
//
// S4: task.status='pending' for longer than the threshold. The scheduler
// should have picked it up in milliseconds; if it hasn't, something is
// wrong (daemon restart leaving the task uncatched, or the scheduler kick
// got dropped).
//
//   - S4.kick-task    — flip task to interrupted briefly then resumeTask
//     to force a fresh scheduler kick. (resumeTask requires non-pending,
//     non-running status, so we go via interrupted.)
//   - S4.cancel-task  — give up; task → canceled. Worktree preserved.

import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'

import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

const S4_KICK_TASK: RepairOptionDef = {
  id: 'S4.kick-task',
  rule: 'S4',
  labelKey: 'diagnose.repair.S4.kickTask.label',
  descriptionKey: 'diagnose.repair.S4.kickTask.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'pending') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S4.unavailable.taskNotPending',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S4' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}') — forces a fresh scheduler kick.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    await rc.db
      .update(tasks)
      .set({
        status: 'interrupted',
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S4',
        errorMessage: `RFC-057 repair S4.kick-task via alert ${rc.alert.id}`,
        failedNodeId: null,
      })
      .where(eq(tasks.id, rc.task.id))
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'interrupted' } },
      resumeAfterApply: true,
    }
  },
}

const S4_CANCEL_TASK: RepairOptionDef = {
  id: 'S4.cancel-task',
  rule: 'S4',
  labelKey: 'diagnose.repair.S4.cancelTask.label',
  descriptionKey: 'diagnose.repair.S4.cancelTask.desc',
  risk: 'high',
  destructive: true,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'pending') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S4.unavailable.taskNotPending',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='canceled', error_summary='manual-repair-S4' WHERE id='${rc.task.id}'`,
        `Worktree preserved.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    await rc.db
      .update(tasks)
      .set({
        status: 'canceled',
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S4',
        errorMessage: `RFC-057 repair S4.cancel-task via alert ${rc.alert.id}`,
      })
      .where(eq(tasks.id, rc.task.id))
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'canceled' } },
    }
  },
}

export const S4_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  S4_KICK_TASK,
  S4_CANCEL_TASK,
]
