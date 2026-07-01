// RFC-128 P5-BC regression — the multi-round self/questioner clarify DEADLOCK fix.
//
// Bug (found 2026-07-01 on live task 01KWDKBS9K22KB6HH4KNR3XMX6 — a DEFERRED self-clarify
// task parked awaiting_human): after answering ROUND 2 of a self-clarify chain, batch
// dispatch was PERMANENTLY rejected with `task-question-node-dispatch-in-flight`
// ("该节点正在重跑，请等其完成后再下发") even though the agent had FINISHED — its
// continuation run was `done` (not running); it was only waiting for the round-2 answers.
//
// Root cause (clarifyRerunLedger.ts openImmediateRounds): the "pending continuation"
// predicate keyed on `!(status === 'done' && hasOutput)`. A self/questioner continuation
// run that ASKS a follow-up clarify round exits `done` WITH NO OUTPUT (runner.ts:1321 keeps
// status=done for a valid <workflow-clarify> envelope; it writes no <workflow-output> port).
// That terminal-but-outputless run — the PREVIOUS round's already-consumed continuation
// (4C5G59 in the live task: rerun_cause='clarify-answer', done, no output) — was mis-counted
// as an in-flight continuation of the CURRENT (next) round, because the predicate scans by
// (nodeId, iteration, cause) and cannot tell "last round's finished continuation" from
// "this round's not-yet-minted continuation". The round therefore stays forever "open" →
// dispatch blocked → the user's answers can never leave the board. A DEADLOCK: the only way
// forward (dispatch) is blocked by a run that is already done.
//
// Fix (mode-scoped so it does NOT regress RFC-127 借壳): openImmediateRounds now takes a `mode`. The
// DISPATCH GATE (findOpenImmediateLedgerHome) asks 'in-flight' — a round's genuine pending
// continuation is by definition NON-TERMINAL (pending/running, incl. the mint-first window), so a
// `done` (or failed/…) continuation of a PRIOR round no longer wedges the NEXT round's dispatch. The
// BORROW consumer (resolveImmediateBorrowForNode) keeps 'revivable' — a done-no-output continuation
// is NOT consumed, so it keeps borrowing (unchanged; locked by the RFC-127 defensive borrow test).
//
// These are PURE unit tests on the exported oracle (openImmediateRounds); the fix flows up
// through findOpenImmediateLedgerHome → assertNoOpenImmediateLedger → dispatchTaskQuestions.

import { describe, expect, test } from 'bun:test'

import { clarifyRounds, nodeRuns } from '../src/db/schema'
import {
  buildImmediateLedgerContext,
  openImmediateRounds,
} from '../src/services/clarifyRerunLedger'

type ClarifyRoundRow = typeof clarifyRounds.$inferSelect
type NodeRunRow = typeof nodeRuns.$inferSelect

const P = 'agent_P'

// openImmediateRounds reads only a handful of columns; these factories fill exactly those
// and cast, so the test locks the oracle's CONTRACT (not the full row shape) and is immune
// to unrelated schema growth.
function mkRound(over: Partial<ClarifyRoundRow>): ClarifyRoundRow {
  return {
    kind: 'self',
    askingNodeId: P,
    status: 'answered',
    askingNodeRunId: 'ask',
    intermediaryNodeRunId: 'inter',
    consumedByConsumerRunId: null,
    consumedByQuestionerRunId: null,
    ...over,
  } as ClarifyRoundRow
}

function mkRun(over: Partial<NodeRunRow>): NodeRunRow {
  return {
    id: 'run',
    nodeId: P,
    iteration: 0,
    parentNodeRunId: null,
    rerunCause: 'clarify-answer',
    status: 'done',
    ...over,
  } as NodeRunRow
}

describe('openImmediateRounds — multi-round self-clarify deadlock (RFC-128 P5-BC)', () => {
  test('DEADLOCK REPRO: a prior round DONE-no-output continuation must NOT keep the next round open', () => {
    // Round 2 answered, NOT dispatched. Its asking run IS the round-1 continuation (4C5G59):
    // rerun_cause='clarify-answer', status='done', NO output (it asked round 2, wrote no port).
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext(
      [round2],
      [cont],
      new Set<string>(), // cont captured NO output row
      new Set<string>(), // round2 not dispatched → immediate-ledger candidate
    )
    // Before the fix this returned [round2] (done-no-output cont counted as pending) →
    // dispatch permanently rejected. After the fix: [].
    expect(openImmediateRounds(P, 0, ctx, 'in-flight')).toEqual([])
  })

  test('true in-flight STILL blocks: a pending continuation keeps the round open (double-mint guard)', () => {
    // Same round 2, but a GENUINE pending continuation B was minted (consumes round 2) and is
    // still running (or the mint-first window). Dispatch MUST stay blocked.
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const pendingB = mkRun({
      id: 'B',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'pending',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext(
      [round2],
      [cont, pendingB],
      new Set<string>(),
      new Set<string>(),
    )
    expect(openImmediateRounds(P, 0, ctx, 'in-flight').map((r) => r.id)).toEqual(['round2'])
  })

  test('consumed continuation (done + output) does NOT block — unchanged behavior', () => {
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    // cont IS in outputRunIds (done + output). Both old and new predicates exclude it.
    const ctx = buildImmediateLedgerContext(
      [round2],
      [cont],
      new Set<string>(['cont']),
      new Set<string>(),
    )
    expect(openImmediateRounds(P, 0, ctx, 'in-flight')).toEqual([])
  })

  test('mode split: a done-no-output continuation is OPEN for borrow (revivable) but NOT for the gate (in-flight)', () => {
    // The exact divergence that makes the `mode` parameter necessary: the BORROW consumer must still
    // see a done-no-output continuation as open (keeps borrowing — RFC-127 defensive), while the
    // DISPATCH GATE must see it as closed (deadlock fix). One shared oracle, two answers.
    const cont = mkRun({
      id: 'cont',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'cont',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext([round2], [cont], new Set<string>(), new Set<string>())
    expect(openImmediateRounds(P, 0, ctx, 'revivable').map((r) => r.id)).toEqual(['round2'])
    expect(openImmediateRounds(P, 0, ctx, 'in-flight')).toEqual([])
  })

  test('Codex impl-gate: a FAILED continuation keeps the gate blocked (revivable → no double-mint)', () => {
    // Codex caught: keying the gate on `!isTerminalNodeRunStatus` would release a FAILED continuation
    // (terminal) from the dispatch gate while the borrow side still treats it as open (revivable —
    // retry/resume re-runs it) → dispatch would mint a SECOND same-home rerun while the old ledger is
    // still borrow-open → irreversible multi-ledger conflict. So the gate keys on `status !== 'done'`,
    // NOT on terminal: a failed/canceled/interrupted continuation stays blocked, exactly like
    // revivable. Only `done` (succeeded, never re-run) is released — which is the done-no-output
    // deadlock case above. Here a done asking run + a FAILED continuation ⇒ still OPEN for BOTH modes.
    const askDone = mkRun({
      id: 'ask',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'done',
    })
    const failedRerun = mkRun({
      id: 'fr',
      nodeId: P,
      iteration: 0,
      rerunCause: 'clarify-answer',
      status: 'failed',
    })
    const round2 = mkRound({
      id: 'round2',
      askingNodeRunId: 'ask',
      intermediaryNodeRunId: 'i2',
      status: 'answered',
    })
    const ctx = buildImmediateLedgerContext(
      [round2],
      [askDone, failedRerun],
      new Set<string>(),
      new Set<string>(),
    )
    expect(openImmediateRounds(P, 0, ctx, 'in-flight').map((r) => r.id)).toEqual(['round2'])
    expect(openImmediateRounds(P, 0, ctx, 'revivable').map((r) => r.id)).toEqual(['round2'])
  })
})
