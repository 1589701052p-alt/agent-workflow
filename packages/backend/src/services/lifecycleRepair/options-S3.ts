// RFC-057 — S3 repair options.
//
// S3 invariant: `task.status='running'` AND every node_run for the task is
// in a terminal status (totalRuns > 0, active === 0). The classic shape
// is the 2026-05-22 incident: review run got force-`interrupted` by the
// orphan reaper while it was momentarily `running` post review-iterate;
// scheduler later hit `dispatchReviewNode` on the still-interrupted row,
// `IllegalNodeRunTransition` bubbled out of runTask, task left `running`
// forever with no live node.
//
// Four options give the operator coverage of the common shapes:
//   - S3.resurrect-review-run  — flip a terminal-non-done review run back
//     to `pending` (allowTerminal) and resume task. Most common.
//   - S3.resurrect-clarify-run — same for clarify.
//   - S3.demote-task           — only demote task to `interrupted` + resume;
//     scheduler decides what to mint next. Bail-out when neither review
//     nor clarify rows look obvious.
//   - S3.mark-task-failed      — give up; task → failed. Worktree kept.

import { eq } from 'drizzle-orm'

import { tasks } from '@/db/schema'
import { setNodeRunStatus } from '@/services/lifecycle'

import { isTerminalNonDone, loadAllNodeRunsForTask } from './helpers'
import type { ApplyResult, PreflightResult, RepairContext, RepairOptionDef } from './types'

// ---------------------------------------------------------------------------
// Common preflight helpers
// ---------------------------------------------------------------------------

interface CandidateResurrectionTarget {
  nodeRunId: string
  nodeId: string
  status: string
  iteration: number
}

async function findResurrectionCandidate(
  rc: RepairContext,
  kind: 'review' | 'clarify',
): Promise<CandidateResurrectionTarget | null> {
  // Parse workflow snapshot to find nodeIds of the requested kind.
  let nodes: Array<{ id?: string; kind?: string }> = []
  try {
    const parsed = JSON.parse(rc.task.workflowSnapshot) as { nodes?: unknown }
    if (Array.isArray(parsed?.nodes)) nodes = parsed.nodes as typeof nodes
  } catch {
    return null
  }
  const targetIds = new Set<string>()
  for (const n of nodes) {
    if (typeof n?.id !== 'string' || typeof n?.kind !== 'string') continue
    if (kind === 'review' && n.kind === 'review') targetIds.add(n.id)
    if (kind === 'clarify' && (n.kind === 'clarify' || n.kind === 'clarify-cross-agent'))
      targetIds.add(n.id)
  }
  if (targetIds.size === 0) return null

  const allRuns = await loadAllNodeRunsForTask(rc.db, rc.task.id)
  // For each target nodeId, find the most-recent terminal-non-done row at the
  // current (review|clarify)Iteration that has no `done` sibling in the same
  // iteration. Most-recent = highest retryIndex.
  type Row = (typeof allRuns)[number]
  const grouped = new Map<string, Row[]>()
  for (const r of allRuns) {
    if (!targetIds.has(r.nodeId)) continue
    const arr = grouped.get(r.nodeId) ?? []
    arr.push(r)
    grouped.set(r.nodeId, arr)
  }
  for (const [nodeId, rows] of grouped) {
    // Group by (iteration, reviewIteration|clarifyIteration). Pick latest by
    // retryIndex within group. If that latest is terminal-non-done AND there's
    // no done sibling in the same group, it's a resurrection candidate.
    const iterKey = (r: Row): string =>
      kind === 'review'
        ? `${r.iteration}|${r.reviewIteration}`
        : `${r.iteration}|${r.clarifyIteration}`
    const byIter = new Map<string, Row[]>()
    for (const r of rows) {
      const k = iterKey(r)
      const arr = byIter.get(k) ?? []
      arr.push(r)
      byIter.set(k, arr)
    }
    for (const [, group] of byIter) {
      const hasDone = group.some((r) => r.status === 'done')
      if (hasDone) continue
      // Latest by retryIndex
      const latest = group.reduce((acc, r) => (r.retryIndex > acc.retryIndex ? r : acc), group[0]!)
      if (isTerminalNonDone(latest.status)) {
        return {
          nodeRunId: latest.id,
          nodeId,
          status: latest.status,
          iteration: latest.iteration,
        }
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// S3.resurrect-review-run
// ---------------------------------------------------------------------------

const S3_RESURRECT_REVIEW: RepairOptionDef = {
  id: 'S3.resurrect-review-run',
  rule: 'S3',
  labelKey: 'diagnose.repair.S3.resurrectReviewRun.label',
  descriptionKey: 'diagnose.repair.S3.resurrectReviewRun.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'running') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
        previewSteps: [],
        ctx: {},
      }
    }
    const cand = await findResurrectionCandidate(rc, 'review')
    if (cand === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.resurrectReviewRun.unavailable.noCandidate',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `setNodeRunStatus(${cand.nodeRunId}, 'pending', allowTerminal) — review node_run ${cand.nodeId} from '${cand.status}' → pending`,
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S3' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}')`,
      ],
      ctx: { candidate: cand },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const cand = pre.ctx['candidate'] as CandidateResurrectionTarget
    const before = {
      nodeRun: { id: cand.nodeRunId, status: cand.status },
      task: { status: rc.task.status },
    }
    await setNodeRunStatus({
      db: rc.db,
      nodeRunId: cand.nodeRunId,
      to: 'pending',
      allowedFrom: ['failed', 'canceled', 'interrupted', 'exhausted'],
      allowTerminal: true,
      extra: { finishedAt: null, errorMessage: null },
      reason: 'S3.resurrect-review-run',
    })
    await rc.db
      .update(tasks)
      .set({
        status: 'interrupted',
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S3',
        errorMessage: `RFC-057 repair S3.resurrect-review-run via alert ${rc.alert.id}`,
        failedNodeId: null,
      })
      .where(eq(tasks.id, rc.task.id))
    return {
      beforeSnapshot: before,
      afterSnapshot: {
        nodeRun: { id: cand.nodeRunId, status: 'pending' },
        task: { status: 'interrupted' },
      },
      resumeAfterApply: true,
    }
  },
}

// ---------------------------------------------------------------------------
// S3.resurrect-clarify-run
// ---------------------------------------------------------------------------

const S3_RESURRECT_CLARIFY: RepairOptionDef = {
  id: 'S3.resurrect-clarify-run',
  rule: 'S3',
  labelKey: 'diagnose.repair.S3.resurrectClarifyRun.label',
  descriptionKey: 'diagnose.repair.S3.resurrectClarifyRun.desc',
  risk: 'low',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'running') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
        previewSteps: [],
        ctx: {},
      }
    }
    const cand = await findResurrectionCandidate(rc, 'clarify')
    if (cand === null) {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.resurrectClarifyRun.unavailable.noCandidate',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `setNodeRunStatus(${cand.nodeRunId}, 'pending', allowTerminal) — clarify node_run ${cand.nodeId} from '${cand.status}' → pending`,
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S3' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}')`,
      ],
      ctx: { candidate: cand },
    }
  },
  async apply(rc, pre): Promise<ApplyResult> {
    const cand = pre.ctx['candidate'] as CandidateResurrectionTarget
    const before = {
      nodeRun: { id: cand.nodeRunId, status: cand.status },
      task: { status: rc.task.status },
    }
    await setNodeRunStatus({
      db: rc.db,
      nodeRunId: cand.nodeRunId,
      to: 'pending',
      allowedFrom: ['failed', 'canceled', 'interrupted', 'exhausted'],
      allowTerminal: true,
      extra: { finishedAt: null, errorMessage: null },
      reason: 'S3.resurrect-clarify-run',
    })
    await rc.db
      .update(tasks)
      .set({
        status: 'interrupted',
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S3',
        errorMessage: `RFC-057 repair S3.resurrect-clarify-run via alert ${rc.alert.id}`,
        failedNodeId: null,
      })
      .where(eq(tasks.id, rc.task.id))
    return {
      beforeSnapshot: before,
      afterSnapshot: {
        nodeRun: { id: cand.nodeRunId, status: 'pending' },
        task: { status: 'interrupted' },
      },
      resumeAfterApply: true,
    }
  },
}

// ---------------------------------------------------------------------------
// S3.demote-task
// ---------------------------------------------------------------------------

const S3_DEMOTE_TASK: RepairOptionDef = {
  id: 'S3.demote-task',
  rule: 'S3',
  labelKey: 'diagnose.repair.S3.demoteTask.label',
  descriptionKey: 'diagnose.repair.S3.demoteTask.desc',
  risk: 'medium',
  destructive: false,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'running') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='interrupted', error_summary='manual-repair-S3' WHERE id='${rc.task.id}'`,
        `resumeTask('${rc.task.id}') — scheduler decides next step`,
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
        errorSummary: 'manual-repair-S3',
        errorMessage: `RFC-057 repair S3.demote-task via alert ${rc.alert.id}`,
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

// ---------------------------------------------------------------------------
// S3.mark-task-failed
// ---------------------------------------------------------------------------

const S3_MARK_FAILED: RepairOptionDef = {
  id: 'S3.mark-task-failed',
  rule: 'S3',
  labelKey: 'diagnose.repair.S3.markTaskFailed.label',
  descriptionKey: 'diagnose.repair.S3.markTaskFailed.desc',
  risk: 'high',
  destructive: true,
  async preflight(rc): Promise<PreflightResult> {
    if (rc.task.status !== 'running') {
      return {
        available: false,
        unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
        previewSteps: [],
        ctx: {},
      }
    }
    return {
      available: true,
      previewSteps: [
        `UPDATE tasks SET status='failed', error_summary='manual-repair-S3' WHERE id='${rc.task.id}'`,
        `Task workspace preserved at worktreePath. No resume.`,
      ],
      ctx: {},
    }
  },
  async apply(rc): Promise<ApplyResult> {
    const before = { task: { status: rc.task.status } }
    await rc.db
      .update(tasks)
      .set({
        status: 'failed',
        finishedAt: rc.now(),
        errorSummary: 'manual-repair-S3',
        errorMessage: `RFC-057 repair S3.mark-task-failed via alert ${rc.alert.id}`,
      })
      .where(eq(tasks.id, rc.task.id))
    return {
      beforeSnapshot: before,
      afterSnapshot: { task: { status: 'failed' } },
    }
  },
}

export const S3_OPTIONS: readonly [RepairOptionDef, ...RepairOptionDef[]] = [
  S3_RESURRECT_REVIEW,
  S3_RESURRECT_CLARIFY,
  S3_DEMOTE_TASK,
  S3_MARK_FAILED,
]
