// RFC-128 P5-BC — the SHARED clarify-rerun ledger oracle (immediate quick-channel + deferred
// dispatched). Extracted from taskQuestionDispatch.ts so its consumers can share ONE oracle without
// an import cycle:
//   - taskQuestionDispatch.ts (dispatch precheck + in-tx recheck + resolveImmediateBorrowForNode):
//     the immediate-ledger oracle (openImmediateRounds / findOpenImmediateLedgerHome /
//     fetchDeferredDispatchedOrigins / isDispatchedEntryConsumed).
//   - clarify.ts / crossClarify.ts (quick-finalize submit — §5.2.14 mixed-path step 1):
//     roundHasDispatchedSelfQuestioner, the submit-side "round is in control-channel dispatch mode"
//     guard (reject a quick whole-round finalize that would drop the un-dispatched answers).
//
// This module sits BELOW all of {clarify, crossClarify, taskQuestions, taskQuestionDispatch} in the
// dependency order (it imports only schema/drizzle/freshness/shared), so any of them may import it.

import { and, eq, inArray, isNotNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { taskQuestions } from '@/db/schema'
import type { clarifyRounds, nodeRuns } from '@/db/schema'
import { pickFreshestRun } from '@/services/freshness'
import { resolveHandlerRun, type RunLineageView } from '@agent-workflow/shared'

type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect
type TaskQuestionRow = typeof taskQuestions.$inferSelect

// RFC-128 P5-BC (§5.2.12 F3) — the rerun-cause class an entry's dispatch mints, derived from its
// 承接 role. A node_run carries ONE rerun_cause; entries of different classes on the same home are
// SEPARATE reruns (serialized, never collapsed). self/questioner causes are isClarifyRerun=TRUE
// (inline resume + directive gating); designer's cross-clarify-answer is FALSE (update mode).
export type CauseClass =
  | 'clarify-answer'
  | 'cross-clarify-questioner-rerun'
  | 'cross-clarify-answer'

// RFC-128 P5-BC (Codex impl-gate, §5.2.3④) — the OPEN IMMEDIATE self/questioner ledger oracle.
//
// The dispatch-time in-flight gate (assertNoInFlightDispatch) only sees `dispatched_at IS NOT NULL`
// entries — it MISSES the immediate ledger (a quick-channel self/questioner continuation:
// `sealed_at` NULL, NOT dispatched, an answered-unconsumed round whose rerun is pending). So a home
// with an open immediate continuation could still ACCEPT a same-home designer dispatch → stamp +
// mint a SECOND pending rerun (double-mint). resolveBorrowForNode would reject it later, but only
// AFTER the irreversible stamp/mint. This oracle lets the dispatch precheck + in-tx recheck count
// the immediate ledger BEFORE the stamp/mint, sharing the SAME open-detection (`openImmediateRounds`)
// that resolveImmediateBorrowForNode uses.
//
// Codex impl-gate (round 4, §5.2.3④ — lazy-reconcile bypass): the oracle reads the TRUTH SOURCE
// (clarify_rounds + the pending continuation node_run), NOT the lazily-projected task_questions. A
// quick-channel answer (submitClarifyAnswers) writes clarify_rounds (answered) + mints a pending
// continuation node_run BEFORE any board read reconciles the task_question — so a task_questions-based
// gate would MISS it on the direct/API/race path and still accept a same-home designer dispatch
// (double-mint). Distinguishing a quick-channel continuation (OPEN — has a pending continuation run)
// from a control-channel sealed-but-parked round (NOT open — no continuation minted) is done by the
// PRESENCE of the pending continuation run, so the oracle never touches task_questions. This aligns
// with the scheduler: it runs that same pending continuation node_run + resolves its agent via
// resolveBorrowForNode — both key on the pending continuation (loadOpenClarify parks awaiting_human;
// after answer the continuation is a normal pending run).
export interface ImmediateLedgerContext {
  /** clarify_rounds of the task (awaiting_human + answered — the immediate-ledger truth source).
   *  NB awaiting_human is included on purpose (Codex round-5 finding 2): submitClarifyAnswers mints
   *  the continuation BEFORE flipping the round 'answered', so the mint-first window has an awaiting
   *  round with a pending continuation. */
  rounds: ReadonlyArray<ClarifyRoundRow>
  /** task node_runs keyed by id (asking-run iteration lookup — P2-3). */
  runById: ReadonlyMap<string, NodeRunRow>
  /** task node_runs (the pending continuation scan). */
  runs: ReadonlyArray<NodeRunRow>
  /** node_run ids that captured ≥1 <workflow-output> row (consumed = done+output). */
  outputRunIds: ReadonlySet<string>
  /** origin node-run ids of rounds whose self/questioner rerun is OWNED BY THE DEFERRED LEDGER —
   *  i.e. the round has a DISPATCHED self/q task_question (`dispatched_at` set). Such a round's
   *  pending role-cause rerun is the control-channel dispatch (resolveDeferredSelfQuestionerBorrow-
   *  ForNode), NOT a quick-channel continuation, so the immediate oracle excludes it (else finding 1:
   *  a legitimate control rerun is double-counted as immediate + deferred → false conflict).
   *
   *  Codex round-6 fix (root cause of finding 6): keyed on `dispatched_at` ONLY — NOT `sealed_at`. A
   *  SEALED-but-undispatched question is not yet owned by the deferred ledger; in a MIXED round
   *  (q1 control-sealed-undispatched + q2 quick-finalized, with q1's answer preserved via
   *  loadSealedQuestionIds/mergeSealedAnswers — clarify.ts:383) the round still has a QUICK
   *  continuation that IS immediate. Excluding on `sealed_at` (fix #5) hid that quick continuation →
   *  double-mint. Dispatched-only exactly mirrors resolveDeferredSelfQuestionerBorrowForNode's
   *  ownership (it keys on `dispatched_at`), so immediate ⊎ deferred partition the rerun cleanly.
   *  (A pure sealed-undispatched control round has no continuation at all → not immediate either,
   *  and is held by the §18 self/q park source until dispatch.) */
  deferredDispatchedOrigins: ReadonlySet<string>
}

export function buildImmediateLedgerContext(
  rounds: ReadonlyArray<ClarifyRoundRow>,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
  deferredDispatchedOrigins: ReadonlySet<string>,
): ImmediateLedgerContext {
  return {
    rounds,
    runById: new Map(runs.map((r) => [r.id, r])),
    runs,
    outputRunIds,
    deferredDispatchedOrigins,
  }
}

/** Pure (shared truth-source oracle) — the OPEN immediate (QUICK-channel) self/questioner clarify
 *  rounds whose HOME (the asking node) is `nodeId` at `iteration`. A round qualifies iff: it is a
 *  self/questioner round on the home with its ASKING run at `iteration` (P2-3); it is NOT terminal;
 *  it is NOT owned by the DEFERRED ledger (no DISPATCHED self/q entry — finding 1+6, so a control
 *  dispatch stays deferred while a mixed round's quick continuation stays immediate); its RFC-070
 *  role stamp is unconsumed; AND a PENDING (not done+output) continuation node_run for the role's
 *  cause exists on the home at `iteration`. The pending continuation is the quick-channel "in flight"
 *  signal, recognised even in the MINT-FIRST window before the round flips 'answered' (finding 2) —
 *  hence no status==='answered' requirement. Uses node_runs + the dispatched-only deferred exclusion,
 *  so the lazy task_question projection never hides an open quick-channel ledger. */
export function openImmediateRounds(
  nodeId: string,
  iteration: number,
  ctx: ImmediateLedgerContext,
): ClarifyRoundRow[] {
  return ctx.rounds.filter((round) => {
    const isSelf = round.kind === 'self' && round.askingNodeId === nodeId
    const isQuestioner = round.kind === 'cross' && round.askingNodeId === nodeId
    if (!isSelf && !isQuestioner) return false
    if (round.status === 'canceled' || round.status === 'abandoned') return false // terminal
    const askingRun = ctx.runById.get(round.askingNodeRunId)
    if (askingRun === undefined || askingRun.iteration !== iteration) return false
    // Finding 1+6 — exclude rounds OWNED BY THE DEFERRED LEDGER (a DISPATCHED self/q entry). A
    // sealed-but-undispatched question does NOT exclude (its round's quick continuation, if any,
    // is still immediate — the mixed-path root cause).
    if (ctx.deferredDispatchedOrigins.has(round.intermediaryNodeRunId)) return false
    // RFC-070 consumed → the quick continuation already ran done+output → closed.
    const consumed = isSelf ? round.consumedByConsumerRunId : round.consumedByQuestionerRunId
    if (consumed !== null) return false
    // Finding 2 — a PENDING (not done+output) continuation run on the home at this iteration with
    // the role's cause = a QUICK-channel continuation in flight, INCLUDING the mint-first window
    // (continuation minted, round not yet flipped 'answered'). A non-dispatched round mints a quick
    // continuation only via the quick channel; the deferred ledger's dispatched reruns were
    // excluded above.
    const cause: CauseClass = isSelf ? 'clarify-answer' : 'cross-clarify-questioner-rerun'
    return ctx.runs.some(
      (r) =>
        r.nodeId === nodeId &&
        r.iteration === iteration &&
        r.parentNodeRunId === null &&
        r.rerunCause === cause &&
        !(r.status === 'done' && ctx.outputRunIds.has(r.id)),
    )
  })
}

/** Origin node-run ids of rounds OWNED BY THE DEFERRED self/questioner ledger — ≥1 self/questioner
 *  task_question with `dispatched_at` set (NOT `sealed_at` — round-6 fix: a sealed-but-undispatched
 *  question keeps its round's quick continuation in the immediate ledger). The immediate-ledger
 *  oracle excludes these; this exactly mirrors resolveDeferredSelfQuestionerBorrowForNode's
 *  `dispatched_at` ownership. Async; the in-tx recheck builds the same set synchronously. */
export async function fetchDeferredDispatchedOrigins(
  db: DbClient,
  taskId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ origin: taskQuestions.originNodeRunId })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
  return new Set(rows.map((r) => r.origin))
}

/** The FIRST affected home with an OPEN immediate self/questioner ledger, or null. Keyed per home
 *  on its dispatch iteration = the freshest run iteration (where the dispatch rerun will be minted
 *  — buildFrontierMintPlan's `last.iteration`), so it matches what resolveBorrowForNode sees when
 *  the home reruns. */
export function findOpenImmediateLedgerHome(
  affected: ReadonlySet<string>,
  runs: ReadonlyArray<NodeRunRow>,
  ctx: ImmediateLedgerContext,
): string | null {
  for (const home of affected) {
    const iter =
      pickFreshestRun(
        runs.filter((r) => r.nodeId === home),
        { topLevelOnly: false },
      )?.iteration ?? 0
    if (openImmediateRounds(home, iter, ctx).length > 0) return home
  }
  return null
}

/** Is a dispatched designer entry CONSUMED? = its handler run, resolved through the same
 *  resolveHandlerRun lineage the read-side uses, is done WITH output (hasOutput is already
 *  folded into `lineageViews`). Queued (trigger NULL), running, failed, or GC'd anchor →
 *  NOT consumed (still open). */
export function isDispatchedEntryConsumed(
  entry: Pick<TaskQuestionRow, 'triggerRunId'>,
  runs: ReadonlyArray<NodeRunRow>,
  lineageViews: RunLineageView[],
): boolean {
  if (entry.triggerRunId === null) return false // queued (not yet bound) → open
  const anchorRow = runs.find((r) => r.id === entry.triggerRunId)
  if (anchorRow === undefined) return false // anchor GC'd → treat as open (conservative)
  const hr = resolveHandlerRun({
    effectiveTargetNodeId: anchorRow.nodeId,
    iteration: anchorRow.iteration,
    loopIter: 0,
    triggerRunId: entry.triggerRunId,
    runs: lineageViews,
  })
  return hr !== null && hr.status === 'done' && hr.hasOutput
}

/** RFC-128 P5-BC §5.2.14 mixed-path step 1 — submit-side dispatch-mode guard. Does `originNodeRunId`
 *  (a clarify / cross-clarify round's intermediary run) carry ANY DISPATCHED self/questioner entry
 *  (`dispatched_at` set), in-flight OR already consumed?
 *
 *  Codex impl-gate finding 1 (data-loss): the read-side PERMANENTLY excludes a round with any
 *  dispatched self/q entry from the whole-round render path (selectAnsweredRoundsForConsumer →
 *  roundsWithDispatchedEntries, keyed on `dispatched_at`, never cleared). So once a round has gone
 *  into control-channel dispatch mode, a quick whole-round finalize for it mints a continuation that
 *  can render NOTHING (the round is excluded from the whole-round path, and the un-dispatched
 *  questions have no per-question queue entry) → the remaining answers are DROPPED. Therefore the
 *  quick-finalize must reject for ANY dispatched self/q entry — NOT just an in-flight one (the old
 *  `isDispatchedEntryConsumed` refinement let a CONSUMED dispatch through → data-loss). The user
 *  finishes such a round via the control channel (seal + dispatch the remaining questions).
 *
 *  In clarify.ts the self-path recheck is done SYNCHRONOUSLY inside the submit's dbTxSync (atomic
 *  with the mint — §5.2.14 step 3); this async helper is the cross-clarify (questioner) submit's
 *  precondition guard. */
export async function roundHasDispatchedSelfQuestioner(
  db: DbClient,
  originNodeRunId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: taskQuestions.id })
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.originNodeRunId, originNodeRunId),
        inArray(taskQuestions.roleKind, ['self', 'questioner']),
        isNotNull(taskQuestions.dispatchedAt),
      ),
    )
    .limit(1)
  return rows.length > 0
}
