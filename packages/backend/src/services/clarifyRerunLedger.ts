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

/** RFC-133: single definition shared by the dispatch grouping/auto-split AND the queued-entry
 *  cause guard in isDispatchedEntryConsumed (moved here from taskQuestionDispatch's private copy). */
export function causeClassForEntry(e: Pick<TaskQuestionRow, 'roleKind'>): CauseClass {
  if (e.roleKind === 'self') return 'clarify-answer'
  if (e.roleKind === 'questioner') return 'cross-clarify-questioner-rerun'
  return 'cross-clarify-answer' // designer (incl. manual)
}

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
  /** node_run ids that captured ≥1 <workflow-output> row (consumed = done+output). Read by
   *  openImmediateRounds in 'revivable' (borrow) mode — a done-no-output continuation is NOT consumed
   *  so it keeps borrowing; the 'in-flight' (dispatch-gate) mode ignores it (keys on non-terminal). */
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

/** RFC-128 P5-BC — the two OPEN semantics the shared oracle serves. They agree on everything EXCEPT
 *  a done-NO-output continuation:
 *   - 'revivable' (BORROW — resolveImmediateBorrowForNode): open = NOT consumed. A continuation is
 *     consumed only when it finished done WITH output (markClarifyRoundsConsumedBy). A done-no-output
 *     continuation is NOT consumed → revivable → keeps borrowing the same handler (locked by the
 *     RFC-127 "done but emitted NO output → still open (keeps borrowing)" test).
 *   - 'in-flight' (DISPATCH GATE — findOpenImmediateLedgerHome): open = status !== 'done'. ONLY a
 *     `done` continuation is gate-closed — done (incl. done-no-output: it ASKED a follow-up round;
 *     runner.ts:1321 keeps status=done with no <workflow-output> port) SUCCEEDED and will not be
 *     re-run, so it cannot double-mint and must NOT block a fresh per-question dispatch (2026-07-01
 *     deadlock fix). A FAILED/canceled/interrupted continuation is NOT gate-closed: it is revivable
 *     (retry/resume re-runs it) and the borrow side still treats it as open, so releasing it would let
 *     dispatch mint a second same-home rerun → an irreversible multi-ledger conflict (Codex impl-gate).
 *     So in-flight diverges from revivable ONLY on done-no-output. */
export type LedgerOpenMode = 'revivable' | 'in-flight'

/** Pure (shared truth-source oracle) — the OPEN immediate (QUICK-channel) self/questioner clarify
 *  rounds whose HOME (the asking node) is `nodeId` at `iteration`. A round qualifies iff: it is a
 *  self/questioner round on the home with its ASKING run at `iteration` (P2-3); it is NOT a
 *  canceled/abandoned round; it is NOT owned by the DEFERRED ledger (no DISPATCHED self/q entry —
 *  finding 1+6, so a control dispatch stays deferred while a mixed round's quick continuation stays
 *  immediate); its RFC-070 role stamp is unconsumed; AND a continuation node_run for the role's cause
 *  exists on the home at `iteration` that is OPEN per `mode` (see LedgerOpenMode). The continuation is
 *  the quick-channel signal, recognised even in the MINT-FIRST window before the round flips
 *  'answered' (finding 2) — hence no status==='answered' requirement. Uses node_runs + the
 *  dispatched-only deferred exclusion, so the lazy task_question projection never hides an open
 *  quick-channel ledger. */
export function openImmediateRounds(
  nodeId: string,
  iteration: number,
  ctx: ImmediateLedgerContext,
  mode: LedgerOpenMode,
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
    // RFC-132 PR-D' 步骤2 (T4): consumed_by 戳废弃——派生。continuation-run 扫描（下方
    // finding 2）对 done+output 的判定与旧戳等价（戳恰在 done+output 时落），故删 short-circuit。
    // Finding 2 — a continuation run on the home at this iteration with the role's cause, OPEN per
    // `mode`, INCLUDING the mint-first window (continuation minted, round not yet flipped 'answered').
    // A non-dispatched round mints a quick continuation only via the quick channel; the deferred
    // ledger's dispatched reruns were excluded above.
    //
    // The two modes diverge ONLY on a done-NO-output continuation. 'revivable' (borrow) counts it as
    // open (NOT consumed → keeps borrowing). 'in-flight' (dispatch gate) does NOT — deadlock fix
    // (2026-07-01, live task 01KWDKBS9K22KB6HH4KNR3XMX6 — see clarify-rerun-ledger-deadlock.test.ts):
    // a self/questioner continuation that ASKS a follow-up round exits `done` WITH NO OUTPUT
    // (runner.ts:1321 — a valid <workflow-clarify> keeps status=done, writes no <workflow-output>
    // port). That done run is the PRIOR round's already-finished continuation; the scan is by
    // (nodeId, iteration, cause) and cannot tell it from the NEXT round's not-yet-minted continuation,
    // so counting it as in-flight wedged the next round's dispatch permanently (blocked by an already-
    // done run → the user's answers could never leave the board).
    //
    // The gate keys on `status !== 'done'` — NOT `!isTerminalNodeRunStatus` (Codex impl-gate): a
    // FAILED/canceled/interrupted continuation is revivable (retry/resume re-runs it) and the borrow
    // side keeps it open, so gate-releasing it would let dispatch mint a SECOND same-home rerun while
    // the old ledger is still borrow-open → an irreversible multi-ledger conflict. Only `done`
    // (succeeded, never re-run) is safe to release; that also uniquely covers the done-no-output
    // deadlock while leaving every non-done status blocked exactly like revivable.
    const cause: CauseClass = isSelf ? 'clarify-answer' : 'cross-clarify-questioner-rerun'
    return ctx.runs.some(
      (r) =>
        r.nodeId === nodeId &&
        r.iteration === iteration &&
        r.parentNodeRunId === null &&
        r.rerunCause === cause &&
        (mode === 'in-flight'
          ? // RFC-132 ②a 缺口②:review-superseded canceled 行已终结(不可 revival),不算 open
            // ——否则 review-iterate 后 immediate gate 永久挡答复的 dispatch。
            r.status !== 'done' && !isReviewSupersededCanceled(r)
          : !(r.status === 'done' && ctx.outputRunIds.has(r.id))),
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
    if (openImmediateRounds(home, iter, ctx, 'in-flight').length > 0) return home
  }
  return null
}

/** Is a dispatched entry CONSUMED? = its handler run (resolved through the same resolveHandlerRun
 *  lineage the read-side uses) has reached the terminal-success bar for `mode`. Running, GC'd
 *  anchor, and every NON-done terminal (failed/canceled/interrupted) → NOT consumed (still open —
 *  revivable via retry/resume) in EITHER mode.
 *
 *  QUEUED (trigger NULL — dispatched but not yet bound by any run's queue injection):
 *   - 'revivable' (borrow oracle): open, unconditionally (unchanged — the deferred rerun is still
 *     owed to this entry).
 *   - 'in-flight' (RFC-133, live-deadlock fix — task 01KWFZRQFPZFQQEM8JTCHQMGP5 "QMGP5"): open ⟺
 *     the entry's EFFECTIVE TARGET (override ?? default) owes a RUN OBLIGATION — it has a
 *     top-level run with `status !== 'done'` (same bar as openImmediateRounds' in-flight scan) —
 *     OR the caller is about to MINT a rerun of a DIFFERENT cause class there (`mintCause`,
 *     Codex design-gate P2: releasing a queued cross-cause entry would let the mint's queue
 *     injection bind it into that alien-cause rerun, collapsing causes §5.2.12 keeps serialized;
 *     a SAME-cause queued entry legitimately rides the mint, like q1+q2 in one batch).
 *     A target with NO runs at all (never-run downstream — its first natural run binds the queue)
 *     or only done runs (idle — the next mint binds it) has no obligation: blocking there is the
 *     circular-wait bug (the "wait for done+output" exit condition could never be satisfied).
 *
 *  `mode` also diverges on a done-NO-output handler (the SAME split as openImmediateRounds —
 *  2026-07-01 deadlock fix): a clarify handler that ASKS a follow-up round exits `done` with NO
 *  <workflow-output> port (runner.ts:1321), and that state is PERMANENT (a clarify-ask never
 *  becomes done+output).
 *   - 'in-flight' (dispatch gate / mint guard / park): done = consumed. A done handler has
 *     terminated and cannot double-mint, so it must NOT keep the home blocked — else a multi-round
 *     clarify chain DEAD-LOCKS (its round-N handler is done-no-output forever, and the gate's
 *     "dispatch after done+output" can never be satisfied → the next round can never dispatch).
 *   - 'revivable' (RFC-127 borrow oracle): done && hasOutput = consumed. A done-no-output handler
 *     has produced nothing → keeps borrowing the same handler (RFC-127 consumed→null tests). */
export function isDispatchedEntryConsumed(
  entry: Pick<
    TaskQuestionRow,
    'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind'
  >,
  runs: ReadonlyArray<NodeRunRow>,
  lineageViews: RunLineageView[],
  mode: LedgerOpenMode,
  /** in-flight only: the cause class the CALLER will mint on this entry's target in the current
   *  operation (dispatch frontier mint / quick-finalize continuation). undefined = no mint there
   *  (the entry just queues — pure run-obligation check). Ignored in 'revivable' mode. */
  mintCause?: CauseClass,
): boolean {
  if (entry.triggerRunId === null) {
    if (mode === 'revivable') return false // queued → open, unconditionally (borrow unchanged)
    const target = entry.overrideTargetNodeId ?? entry.defaultTargetNodeId
    if (target === null || target === '') return false // no target (data anomaly) → conservative
    if (mintCause !== undefined && causeClassForEntry(entry) !== mintCause) return false // (b)
    const hasRunObligation = runs.some(
      (r) =>
        r.nodeId === target &&
        r.parentNodeRunId === null &&
        r.status !== 'done' &&
        // RFC-132 ②a 缺口②:review supersede 把 done handler 翻 canceled(marker),该行已终结、
        // 不可 revival(RFC-095),不构成 run 义务——否则 review-iterate 后的下一次答复永久卡
        // in-flight(与 isTargetNodeConsumed 的 supersede 例外同判据)。
        !isReviewSupersededCanceled(r),
    )
    return !hasRunObligation // (a) no open run on the target → nothing in flight → consumed
  }
  const anchorRow = runs.find((r) => r.id === entry.triggerRunId)
  if (anchorRow === undefined) return false // anchor GC'd → treat as open (conservative)
  // RFC-132 ②a 缺口②:lineage 投影把 review-superseded canceled 行视作 done——它是「完成过又被
  // review 取代」的 handler(isTargetNodeConsumed :447 同判据),freshest 落在它上时该 entry 的
  // 义务已了结(in-flight: consumed;revivable: 按 hasOutput),不再永久挡 dispatch。
  const supersededIds = new Set(runs.filter((r) => isReviewSupersededCanceled(r)).map((r) => r.id))
  const projected =
    supersededIds.size === 0
      ? lineageViews
      : lineageViews.map((v) =>
          supersededIds.has(v.id) ? { ...v, status: 'done' as NodeRunRow['status'] } : v,
        )
  const hr = resolveHandlerRun({
    effectiveTargetNodeId: anchorRow.nodeId,
    iteration: anchorRow.iteration,
    loopIter: 0,
    triggerRunId: entry.triggerRunId,
    runs: projected,
  })
  if (hr === null || hr.status !== 'done') return false
  return mode === 'in-flight' ? true : hr.hasOutput
}

/** RFC-132 ②a 缺口② — review supersede 例外的单一判据(与 isTargetNodeConsumed :447 /
 *  dispatchFrontier.isReviewSupersededRow 同源):canceled + errorMessage 带 supersede marker。 */
function isReviewSupersededCanceled(r: Pick<NodeRunRow, 'status' | 'errorMessage'>): boolean {
  return (
    r.status === 'canceled' && r.errorMessage?.startsWith(REVIEW_SUPERSEDE_MARKER_PREFIX) === true
  )
}

/** The resolveHandlerRun lineage projection (the SAME shape findOpenDispatchTarget passes) so
 *  "consumed" is defined identically wherever isDispatchedEntryConsumed runs. */
function toLineageViews(
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): RunLineageView[] {
  return runs.map((r) => ({
    id: r.id,
    nodeId: r.nodeId,
    iteration: r.iteration,
    loopIter: 0,
    rerunCause: r.rerunCause,
    status: r.status,
    startedAt: r.startedAt,
    hasOutput: outputRunIds.has(r.id),
    parentNodeRunId: r.parentNodeRunId,
  }))
}

/** RFC-128 P5-BC §5.2.14 (reciprocal in-flight check, PRECISE). Pure/sync — is there an OPEN
 *  (unconsumed) DISPATCHED entry of ANY deferred role (self/questioner/designer) whose EFFECTIVE
 *  TARGET (`override ?? default`, per findOpenDispatchTarget — RFC-131 T4 去借壳) is `homeNodeId`? This is the dispatch-side
 *  mirror the submit-side mint needs: a concurrent deferred dispatch of ANOTHER round's entry
 *  reassigned (RFC-127 借壳) to the cascade's home stamps it + mints a pending rerun on that home;
 *  without this the cascade mints a SECOND open ledger on the same (home, iteration).
 *
 *  ALL-ROLE (3rd-gate finding P2): a node carries at most ONE open rerun ledger — a self/questioner
 *  quick-finalize must NOT mint a `clarify-answer`/`cross-clarify-questioner-rerun` next to an EXISTING
 *  open dispatched DESIGNER (`cross-clarify-answer`) rerun on the same home, or the scheduler later
 *  sees multiple open ledgers for one node (mirrors assertNoInFlightDispatch, which spans any deferred
 *  role). Keyed on a DISPATCHED entry (NOT "any pending rerun"): a prior round's quick continuation
 *  has no dispatched entry → the legitimate sequential multi-round flow is not falsely rejected.
 *  Consumed dispatched entries are not a live conflict — this is a MINT GUARD, so it uses the
 *  'in-flight' consume bar: a done handler (incl. done-no-output — it asked a follow-up round) has
 *  terminated and cannot double-mint, so it must NOT block the next round's mint (else deadlock).
 *  The data-loss guard for a dispatched round is roundHasDispatchedSelfQuestioner (keys dispatched_at,
 *  incl. consumed), which runs BEFORE this check — so releasing done-no-output here is safe. */
export function hasOpenDispatchedEntryOnHome(
  homeNodeId: string,
  dispatchedEntries: ReadonlyArray<
    Pick<
      TaskQuestionRow,
      'triggerRunId' | 'defaultTargetNodeId' | 'overrideTargetNodeId' | 'roleKind'
    >
  >,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
  /** RFC-133: the cause class of the continuation the CALLER is about to mint on this home
   *  (quick-finalize self → 'clarify-answer', questioner → 'cross-clarify-questioner-rerun').
   *  A queued entry of a DIFFERENT cause must still block the mint (it would otherwise be
   *  bound into the alien-cause continuation — Codex design-gate P2). */
  mintCause: CauseClass,
): boolean {
  const onHome = dispatchedEntries.filter(
    (e) => (e.overrideTargetNodeId ?? e.defaultTargetNodeId) === homeNodeId,
  )
  if (onHome.length === 0) return false
  const lineageViews = toLineageViews(runs, outputRunIds)
  return onHome.some(
    (e) => !isDispatchedEntryConsumed(e, runs, lineageViews, 'in-flight', mintCause),
  )
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

/** RFC-131 — 派生式老化判据（取代 isQueueEntryRenderableForRun 的 window 消费 + isDispatchedEntryConsumed
 *  的 in-flight/revivable mode 分裂）。一个 target 队列里、承接 rerun 为 `sinceRunId`（问题的
 *  `trigger_run_id`）的问题是否「已被 target 产出老化」= 该 (target, iteration) 有一个 TOP-LEVEL run 处于
 *  `done` + 捕获 ≥1 <workflow-output>（正常输出走完），**且其 id ≥ `sinceRunId`**（承接 rerun 本身或其后
 *  的 rerun 产出——ULID 单调递增，id 序等价「问题被承接之后 target 产出了」）。
 *
 *  为什么用 trigger_run_id 的 id 序锚（而非 startedAt 时间锚、也非笼统「node 有过 done+output」）：
 *   - 笼统会误伤 round N+1（node 产出后再开新一轮反问，那批新问题不能被上次产出老化）；
 *   - startedAt 脆弱（mint 时为 null、runner spawn 才 set；时钟精度）；
 *   - trigger_run_id 是问题注入时绑定的承接 rerun（buildClarify*Context 绑），ULID 单调 → id 序 robust。
 *  关键：**不设 window 上界**——renderableForRun 的「下一 clarify rerun」上界会把 round 1 在 round 2 的
 *  rerun 里排除（正是多轮丢历史根因）；这里只要承接 rerun 或其后 target 产出过，就老化。
 *
 *  三态（RFC-131 §2 核心正确性）：
 *   - 承接 rerun（id ≥ sinceRunId）后 target `done`+output → TRUE：老化、定型、不再注入。
 *   - `done` 无 output（问了下一轮反问；runner.ts:1321 对 <workflow-clarify> 保持 done、不写 port）→
 *     FALSE：不老化，答案留队列、下一次 rerun 继续注入（修多轮丢历史轮 + 天然避免下发死锁）。
 *   - review reject/iterate supersede 后的 `canceled`+output（errorMessage 带 `superseded-by-review-` 前缀）→
 *     TRUE：design §74「第一次 done+output 即永久老化」——reject 把产出 run 翻 canceled 但保留 output，老化
 *     须存活，否则 reject 重做重注已答 clarify（验收4 bug）。RFC-119 prior-output 同样对 canceled 存活。
 *   - failed / 非-review-superseded canceled / interrupted / pending / running / awaiting_* → FALSE：未产出（revivable / 在飞）。
 *   - `sinceRunId === null`（问题尚未被任何 rerun 承接注入）→ FALSE：未处理、注入（首次绑定）。
 *
 *  派生式（读时按 run 状态 + id 序算、不落库）：单一事实源、崩溃 replay 一致、零 schema migration、
 *  幂等。fanout 子 run（parentNodeRunId 非 null）不作数——只看 top-level 产出。 */
// review reject/iterate supersede 把 done+output run 翻成 canceled 但保留 output（review.ts）。canonical
// 定义在 dispatchFrontier.REVIEW_SUPERSEDE_MARKER_PREFIX / isReviewSupersededRow；本模块是底层（文件头注释：
// 只 import schema/drizzle/freshness/shared），不 import dispatchFrontier（避免破底层原则 + 传递循环
// dispatchFrontier→wrapperProgress）。用同值常量 + source-text 测试锁（review-supersede-marker-parity）防漂移。
const REVIEW_SUPERSEDE_MARKER_PREFIX = 'superseded-by-review-'

export function isTargetNodeConsumed(
  targetNodeId: string,
  iteration: number,
  sinceRunId: string | null,
  runs: ReadonlyArray<NodeRunRow>,
  outputRunIds: ReadonlySet<string>,
): boolean {
  if (sinceRunId === null) return false
  return runs.some(
    (r) =>
      r.nodeId === targetNodeId &&
      r.iteration === iteration &&
      r.parentNodeRunId === null &&
      // done+output 或 review reject/iterate supersede 后的 canceled+output（design §74「第一次 done+output
      // 即永久老化」：reject 把产出 run 翻 canceled 但保留 output，若不认它则 reject 重做会重注已答 clarify
      // ——验收4 bug）。failed / 非-review canceled / interrupted / pending / running+output 仍不老化（revivable / 在飞）。
      (r.status === 'done' ||
        (r.status === 'canceled' &&
          r.errorMessage?.startsWith(REVIEW_SUPERSEDE_MARKER_PREFIX) === true)) &&
      outputRunIds.has(r.id) &&
      r.id >= sinceRunId,
  )
}
