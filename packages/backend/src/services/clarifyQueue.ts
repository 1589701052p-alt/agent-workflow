// RFC-132 PR-1 (T2) — the unified agent-queue selection + derived-aging helper.
//
// The DRY extraction of the ~60 duplicated lines shared by buildClarifyNodeQueueContext
// (clarifyRounds.ts, self / questioner) and buildNodeQueueExternalFeedback (crossClarify.ts,
// designer): pick a node's DISPATCHED, (sealed OR manual), UN-AGED task_questions — projected by
// effectiveTarget (override ?? default) — resolve each entry's Q&A (or manual body) for the flat
// renderer (T1), and — as an INDEPENDENT write — bind the picked entries' trigger_run_id to the
// current rerun (承接 marker).
//
// Layering (reference_binary_build_module_cycle): this module sits ABOVE clarifyRerunLedger (it
// imports isTargetNodeConsumed, the single RFC-131 derived-aging oracle) and BELOW clarifyRounds /
// crossClarify (which route through it in PR-2 / T3). It imports only schema / drizzle / util-log /
// clarifyRerunLedger / shared — no upward import — so wiring it into the two legacy injectors later
// introduces no module cycle.
//
// PR-1 lands it UNWIRED (no caller): the two legacy injectors are untouched. PR-2 (T3) drops it in
// and deletes the fork.

import { and, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { clarifyRounds, nodeRunOutputs, nodeRuns, taskQuestions } from '@/db/schema'
import { isTargetNodeConsumed } from '@/services/clarifyRerunLedger'
import { createLogger } from '@/util/log'
import type { ClarifyAnswer, ClarifyQuestion, FlatClarifyEntry } from '@agent-workflow/shared'

const log = createLogger('clarify-queue')

export interface SelectAgentQueueArgs {
  db: DbClient
  taskId: string
  /** The running agent node. Its "agent queue" = task_questions projected to it by
   *  effectiveTarget (override_target_node_id ?? default_target_node_id). */
  consumerNodeId: string
  /** This run's node_run id. Frames the (node, iteration) lineage window the derived-aging oracle
   *  scans, and is the trigger_run_id bindTriggerRun stamps. */
  dispatchedRunId: string
}

/** One un-aged entry of a node's agent queue, resolved for the flat renderer (T1). */
export interface AgentQueueEntry {
  /** task_questions.id — pass to bindTriggerRun. */
  id: string
  /** dispatched_at ordering anchor (the result is pre-sorted by dispatched_at then id). */
  dispatchedAt: number | null
  roleKind: 'self' | 'questioner' | 'designer'
  sourceKind: 'self' | 'cross' | 'manual'
  /** Render payload for renderFlatClarifyQueue: a resolved Q&A or a manual instruction. */
  render: FlatClarifyEntry
}

/**
 * Select a node's agent queue: DISPATCHED, (sealed OR manual), UN-AGED task_questions whose
 * effectiveTarget (override ?? default) is `consumerNodeId`, resolved to render-ready entries
 * (Q&A from the origin clarify round, or the manual body). PURE READ — no writes (binding is the
 * separate {@link bindTriggerRun}). Returns [] when the node has nothing to inject.
 *
 * Aging is RFC-131 derived ({@link isTargetNodeConsumed}): an entry ages out once its target
 * produced a done+output (or review-superseded canceled+output) top-level run at or after the
 * entry's trigger_run_id — read from run state, never persisted (crash-replay stable, zero schema).
 * An entry whose clarify round vanished / was canceled / abandoned / has no answers is dropped
 * (unrenderable); an all-empty manual entry is dropped too.
 *
 * Every role (self / questioner / designer) is selected in ONE query — the unified agent queue
 * (design §2 "consumerKind 消失"): no per-role SELECT fork. The sealed filter is `sealed_at IS NOT
 * NULL OR source_kind='manual'` (manual §15 carries no clarify answer / no seal but still injects
 * its manual_body).
 */
export async function selectAgentQueue(args: SelectAgentQueueArgs): Promise<AgentQueueEntry[]> {
  const { db, taskId, consumerNodeId, dispatchedRunId } = args

  // 1. All DISPATCHED entries whose EFFECTIVE TARGET (override ?? default) is this node — every role
  //    in one query. RFC-131 T4 去借壳: select by the target the rerun is minted on (a reassign
  //    moves the run to the target node), not the origin home — reading the origin would miss a
  //    reassigned entry.
  const candidates = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        isNotNull(taskQuestions.dispatchedAt),
        or(
          eq(taskQuestions.overrideTargetNodeId, consumerNodeId),
          and(
            isNull(taskQuestions.overrideTargetNodeId),
            eq(taskQuestions.defaultTargetNodeId, consumerNodeId),
          ),
        ),
      ),
    )
  const dispatched = candidates.filter((e) => e.sealedAt !== null || e.sourceKind === 'manual')
  if (dispatched.length === 0) return []

  // 2. Frame the lineage window on this run's node + iteration (mirrors resolveHandlerRun): all of
  //    the node's runs at this iteration are the process-retry / clarify-rerun chain the derived-
  //    aging oracle scans.
  const rRow = (
    await db.select().from(nodeRuns).where(eq(nodeRuns.id, dispatchedRunId)).limit(1)
  )[0]
  const iteration = rRow?.iteration ?? 0
  const sameNode = rRow
    ? await db
        .select()
        .from(nodeRuns)
        .where(
          and(
            eq(nodeRuns.taskId, taskId),
            eq(nodeRuns.nodeId, consumerNodeId),
            eq(nodeRuns.iteration, iteration),
          ),
        )
    : []
  const outputRunIds = await runIdsWithOutput(
    db,
    sameNode.map((r) => r.id),
  )
  const aged = dispatched.filter(
    (e) => !isTargetNodeConsumed(consumerNodeId, iteration, e.triggerRunId, sameNode, outputRunIds),
  )
  if (aged.length === 0) return []

  // 3. Resolve each entry's render payload. Clarify entries derive (question, answer) from their
  //    origin clarify round; manual entries (§15) inject their human-authored body.
  const clarifyOriginIds = [
    ...new Set(aged.filter((e) => e.sourceKind !== 'manual').map((e) => e.originNodeRunId)),
  ]
  const roundByOrigin = new Map<
    string,
    { questions: Map<string, ClarifyQuestion>; answers: Map<string, ClarifyAnswer> }
  >()
  for (const originId of clarifyOriginIds) {
    const round = (
      await db
        .select()
        .from(clarifyRounds)
        .where(eq(clarifyRounds.intermediaryNodeRunId, originId))
        .limit(1)
    )[0]
    if (
      round === undefined ||
      round.status === 'canceled' ||
      round.status === 'abandoned' ||
      round.answersJson === null
    )
      continue
    let questions: ClarifyQuestion[]
    let answers: ClarifyAnswer[]
    try {
      questions = JSON.parse(round.questionsJson) as ClarifyQuestion[]
      answers = JSON.parse(round.answersJson) as ClarifyAnswer[]
    } catch (err) {
      log.warn('clarify queue round JSON parse failed; skipping round', {
        roundId: round.id,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    roundByOrigin.set(originId, {
      questions: new Map(questions.map((q) => [q.id, q])),
      answers: new Map(answers.map((a) => [a.questionId, a])),
    })
  }

  const result: AgentQueueEntry[] = []
  for (const e of aged) {
    let render: FlatClarifyEntry | undefined
    if (e.sourceKind === 'manual') {
      const hasContent =
        (e.manualTitle ?? '').trim().length > 0 || (e.manualBody ?? '').trim().length > 0
      if (hasContent) render = { manualTitle: e.manualTitle, manualBody: e.manualBody }
    } else {
      const round = roundByOrigin.get(e.originNodeRunId)
      const question = round?.questions.get(e.questionId)
      if (question !== undefined) render = { question, answer: round!.answers.get(e.questionId) }
    }
    if (render === undefined) continue
    result.push({
      id: e.id,
      dispatchedAt: e.dispatchedAt,
      roleKind: e.roleKind,
      sourceKind: e.sourceKind,
      render,
    })
  }

  // Stable flat order (design §5): dispatched_at then id (ULID monotonic tiebreak).
  result.sort(
    (a, b) =>
      (a.dispatchedAt ?? 0) - (b.dispatchedAt ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  return result
}

/**
 * Bind trigger_run_id = dispatchedRunId on the given entries — the 承接 marker the derived-aging
 * oracle reads next run (an entry ages out once its target produced done+output at/after this id).
 * INDEPENDENT write (split from {@link selectAgentQueue} per plan T2 so both are unit-testable).
 * Only rows NOT already pinned to dispatchedRunId are written (unbound NULLs + earlier-lineage
 * rebinds), so a re-render of the same run is idempotent (no updated_at churn). Returns the ids
 * actually bound.
 */
export async function bindTriggerRun(
  db: DbClient,
  entryIds: string[],
  dispatchedRunId: string,
): Promise<string[]> {
  if (entryIds.length === 0) return []
  const toBind = await db
    .select({ id: taskQuestions.id })
    .from(taskQuestions)
    .where(
      and(
        inArray(taskQuestions.id, entryIds),
        or(isNull(taskQuestions.triggerRunId), ne(taskQuestions.triggerRunId, dispatchedRunId)),
      ),
    )
  const ids = toBind.map((r) => r.id)
  if (ids.length === 0) return []
  await db
    .update(taskQuestions)
    .set({ triggerRunId: dispatchedRunId, updatedAt: Date.now() })
    .where(inArray(taskQuestions.id, ids))
  return ids
}

/** node_run ids (within `runIds`) that captured ≥1 `<workflow-output>` row. */
async function runIdsWithOutput(db: DbClient, runIds: string[]): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const rows = await db
    .select({ nodeRunId: nodeRunOutputs.nodeRunId })
    .from(nodeRunOutputs)
    .where(inArray(nodeRunOutputs.nodeRunId, runIds))
  return new Set(rows.map((r) => r.nodeRunId))
}
