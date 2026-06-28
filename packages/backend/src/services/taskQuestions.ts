// RFC-120 — task question list / 任务中心 read-side service.
//
// Collection (reconcile) + handler-run resolution + list are all LAZY / read-time:
// derived from the existing clarify_rounds + node_runs + node_run_outputs, so the
// ledger needs ZERO edits to clarify.ts / crossClarify.ts (the answer→dispatch
// backend stays untouched — important while a concurrent RFC occupies those files).
//
//   * reconcileTaskQuestionsForRound — one clarify_round → its handler entries
//     (问题 × 承接角色), upserted idempotently (preserves the manual overlay:
//     override / confirmation / staged / audit).
//   * resolveTriggerForEntry — the entry's anchor handler rerun id, resolved from
//     the round's RFC-070 consumption stamps (authoritative for done handlers,
//     Codex F4) with a best-effort cause-query fallback for in-flight handlers.
//   * listTaskQuestions — lazy-reconcile every round of a task, then derive each
//     entry's phase (pure deriveQuestionPhase + precise resolveHandlerRun lineage)
//     into a DTO for the board / clarify-page / node badge.
//
// See design/RFC-120-task-question-list §2.3 / §4 / §11.

import { eq, inArray } from 'drizzle-orm'
import { ulid } from 'ulid'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions } from '@/db/schema'
import { dbTxSync } from '@/db/txSync'
import {
  deriveQuestionPhase,
  NEW_CLARIFY_TRIGGER_CAUSES,
  reconcileDesiredEntries,
  resolveHandlerRun,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
  type RunLineageView,
  type TaskQuestionPhase,
} from '@agent-workflow/shared'

type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

const TRIGGER_CAUSES = new Set<string>(NEW_CLARIFY_TRIGGER_CAUSES)

export interface TaskQuestionDTO {
  id: string
  taskId: string
  originNodeRunId: string
  questionId: string
  questionTitle: string
  sourceKind: 'self' | 'cross'
  roleKind: 'self' | 'questioner' | 'designer'
  /** The node that ASKED the question (round.askingNodeId) — drives the node badge. */
  sourceNodeId: string
  defaultTargetNodeId: string | null
  overrideTargetNodeId: string | null
  /** override ?? default — who currently handles it. */
  effectiveTargetNodeId: string | null
  phase: TaskQuestionPhase
  confirmation: 'open' | 'confirmed'
  confirmedBy: string | null
  /** staged into 待下发 but not yet dispatched. */
  staged: boolean
  reopenCount: number
  /** Brief of the human's answer for this question (null if unanswered). */
  answerSummary: string | null
  createdAt: number
  updatedAt: number
}

function parseQuestions(json: string): ClarifyQuestion[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyQuestion[]) : []
  } catch {
    return []
  }
}

function parseScopes(json: string | null): Record<string, ClarifyQuestionScope> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as Record<string, ClarifyQuestionScope>) : {}
  } catch {
    return {}
  }
}

function parseAnswers(json: string | null): ClarifyAnswer[] {
  if (!json) return []
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? (v as ClarifyAnswer[]) : []
  } catch {
    return []
  }
}

/** Graph role nodes read straight off the round row (no workflow-def / find* needed):
 *  self → askingNodeId is the asking node; cross → askingNodeId is the questioner,
 *  targetConsumerNodeId is the (default) designer. */
function graphForRound(round: ClarifyRoundRow) {
  return {
    askingNodeId: round.kind === 'self' ? round.askingNodeId : null,
    questionerNodeId: round.kind === 'cross' ? round.askingNodeId : null,
    designerNodeId: round.targetConsumerNodeId,
  }
}

/** One clarify_round → upsert its desired handler entries (idempotent; preserves
 *  override / confirmation / staged / audit on existing rows). */
export function reconcileTaskQuestionsForRound(db: DbClient, round: ClarifyRoundRow): void {
  const desired = reconcileDesiredEntries({
    kind: round.kind,
    questions: parseQuestions(round.questionsJson),
    roundAnswered: round.status === 'answered',
    scopes: parseScopes(round.questionScopesJson),
    graph: graphForRound(round),
  })
  if (desired.length === 0) return
  const now = Date.now()
  dbTxSync(db, (tx) => {
    for (const d of desired) {
      tx.insert(taskQuestions)
        .values({
          id: ulid(),
          taskId: round.taskId,
          originNodeRunId: round.intermediaryNodeRunId,
          questionId: d.questionId,
          questionTitle: d.questionTitle,
          sourceKind: d.sourceKind,
          roleKind: d.roleKind,
          iteration: round.iteration,
          loopIter: round.loopIter,
          defaultTargetNodeId: d.defaultTargetNodeId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [taskQuestions.originNodeRunId, taskQuestions.questionId, taskQuestions.roleKind],
          // Only refresh the graph-derived snapshot; never touch the manual overlay.
          set: {
            defaultTargetNodeId: d.defaultTargetNodeId,
            questionTitle: d.questionTitle,
            updatedAt: now,
          },
        })
        .run()
    }
  })
}

/** The entry's anchor handler rerun id. Prefer the RFC-070 consumption stamp
 *  (authoritative once the handler finished done+output, Codex F4); fall back to
 *  the freshest in-flight target-node rerun with a trigger cause minted after the
 *  round's asking run (best-effort for the common single-round case). */
function resolveTriggerForEntry(
  round: ClarifyRoundRow,
  roleKind: TaskQuestionRow['roleKind'],
  effectiveTargetNodeId: string | null,
  runs: NodeRunRow[],
): string | null {
  if (round.status !== 'answered') return null // not dispatched
  const stamp =
    roleKind === 'questioner' ? round.consumedByQuestionerRunId : round.consumedByConsumerRunId
  if (stamp) return stamp
  if (effectiveTargetNodeId === null) return null
  // best-effort: freshest trigger-cause rerun of the target node at this loopIter,
  // minted after the round's asking run.
  let best: string | null = null
  for (const r of runs) {
    if (
      r.nodeId === effectiveTargetNodeId &&
      r.iteration === round.loopIter &&
      r.parentNodeRunId === null &&
      r.rerunCause !== null &&
      TRIGGER_CAUSES.has(r.rerunCause) &&
      r.id > round.askingNodeRunId
    ) {
      if (best === null || r.id > best) best = r.id
    }
  }
  return best
}

/** Lazy-reconcile every round of a task and project each entry into a DTO with
 *  its derived phase. Optional filters: by source node (node badge / clarify page)
 *  and/or by phase (board column). */
export async function listTaskQuestions(
  db: DbClient,
  taskId: string,
  opts: { sourceNodeId?: string; phase?: TaskQuestionPhase } = {},
): Promise<TaskQuestionDTO[]> {
  const rounds = await db.select().from(clarifyRounds).where(eq(clarifyRounds.taskId, taskId))
  for (const round of rounds) reconcileTaskQuestionsForRound(db, round)

  const entries = await db.select().from(taskQuestions).where(eq(taskQuestions.taskId, taskId))
  if (entries.length === 0) return []

  const runs = await db.select().from(nodeRuns).where(eq(nodeRuns.taskId, taskId))
  const outputRunIds = await runIdsWithOutput(
    db,
    runs.map((r) => r.id),
  )
  const roundByOrigin = new Map(rounds.map((r) => [r.intermediaryNodeRunId, r]))

  const out: TaskQuestionDTO[] = []
  for (const e of entries) {
    const round = roundByOrigin.get(e.originNodeRunId)
    if (!round) continue // round vanished (task edited); skip defensively
    const effectiveTargetNodeId = e.overrideTargetNodeId ?? e.defaultTargetNodeId
    const triggerRunId = resolveTriggerForEntry(round, e.roleKind, effectiveTargetNodeId, runs)
    const lineageRuns: RunLineageView[] = runs.map((r) => ({
      id: r.id,
      nodeId: r.nodeId,
      // node_runs carries a single `iteration` = the loop iteration; clarify_rounds
      // tracks loopIter separately. Match the run's iteration against the entry's
      // loopIter on both axes (the round-counter `iteration` is disambiguated by the
      // trigger anchor + lineage window, not by a run column).
      iteration: r.iteration,
      loopIter: r.iteration,
      rerunCause: r.rerunCause,
      status: r.status,
      startedAt: r.startedAt,
      hasOutput: outputRunIds.has(r.id),
      parentNodeRunId: r.parentNodeRunId,
    }))
    const handlerRun = resolveHandlerRun({
      effectiveTargetNodeId,
      iteration: e.loopIter,
      loopIter: e.loopIter,
      triggerRunId,
      runs: lineageRuns,
    })
    const phase = deriveQuestionPhase({
      roundStatus: round.status,
      confirmation: e.confirmation,
      isStaged: e.stagedAt !== null,
      handlerRun,
    })
    if (opts.sourceNodeId && round.askingNodeId !== opts.sourceNodeId) continue
    if (opts.phase && phase !== opts.phase) continue
    out.push({
      id: e.id,
      taskId: e.taskId,
      originNodeRunId: e.originNodeRunId,
      questionId: e.questionId,
      questionTitle: e.questionTitle,
      sourceKind: e.sourceKind,
      roleKind: e.roleKind,
      sourceNodeId: round.askingNodeId,
      defaultTargetNodeId: e.defaultTargetNodeId,
      overrideTargetNodeId: e.overrideTargetNodeId,
      effectiveTargetNodeId,
      phase,
      confirmation: e.confirmation,
      confirmedBy: e.confirmedBy,
      staged: e.stagedAt !== null,
      reopenCount: e.reopenCount,
      answerSummary: summarizeAnswer(round, e.questionId),
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    })
  }
  return out
}

async function runIdsWithOutput(db: DbClient, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, runIds))
  return new Set(rows.map((r) => r.nodeRunId))
}

/** Short human-readable summary of the answer to one question (labels + custom). */
function summarizeAnswer(round: ClarifyRoundRow, questionId: string): string | null {
  if (round.status !== 'answered') return null
  const ans = parseAnswers(round.answersJson).find((a) => a.questionId === questionId)
  if (!ans) return null
  const parts: string[] = []
  if (ans.selectedOptionLabels.length > 0) parts.push(ans.selectedOptionLabels.join(', '))
  if (ans.customText.trim()) parts.push(ans.customText.trim())
  const s = parts.join(' · ')
  return s.length > 200 ? `${s.slice(0, 200)}…` : s || null
}
