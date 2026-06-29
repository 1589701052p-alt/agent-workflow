// RFC-128 — per-question answer seal primitive (落库方案 C).
//
// This is the storage-layer vehicle the per-question answer endpoints (P2) and the
// centralized-answer pane (P4) build on. It seals a SUBSET of a clarify round's
// questions without minting any rerun (the defer/control channel; the quick-channel
// rerun mint stays in clarify.ts/crossClarify.ts). The ENTIRE sequence runs inside ONE
// dbTxSync (RFC-128 P2-1): the round + its entries are re-read inside the transaction
// and every write commits atomically, so two overlapping seals on the same round cannot
// lose-update answers_json or land "all sealed but round still awaiting_human". For each
// call it:
//
//   1. seals the passed answers server-side (sealAnswersServerSide — option-label
//      forgery defense, unknown-question drop) and MERGES them into the round's
//      `answers_json` (per-question merge-write; answers stay the content SoT);
//   2. merges any per-question scope choice into the round's `question_scopes_json`
//      (scope is chosen when a cross question is answered — RFC-128 §4 / P2-3);
//   3. reconciles the round's task_questions entries (questioner/self always; designer
//      ONLY once the whole round is sealed — P2-4 option (a); per-question designer
//      entries + dispatch are P3);
//   4. stamps `sealed_at` on the (question × role) entries sealed by THIS call;
//   5. flips the round → 'answered' ONLY when EVERY question is now sealed (T4); a
//      partial seal leaves the round 'awaiting_human' (partial is a pure derived state,
//      never a new DB status — protects RFC-126's failed→resume invariant).
//
// Golden-lock: sealing ALL of a virgin round's questions in one call reproduces the old
// whole-round seal byte-for-byte on the observable columns (answers_json content +
// status flip), since merge-into-empty == overwrite and all-sealed == flip.
//
// Re-sealing an already-sealed question is rejected (the quick channel + control
// channel share this per-question state — a question can be sealed exactly once).

import { and, eq, inArray, isNull } from 'drizzle-orm'

import type { DbClient } from '@/db/client'
import { dbTxSync } from '@/db/txSync'
import { clarifyRounds, clarifySessions, crossClarifySessions, taskQuestions } from '@/db/schema'
import { parseAnswersArray, sealAnswersServerSide } from '@/services/clarify'
import { reconcileRoundEntriesTx } from '@/services/taskQuestions'
import { ConflictError, NotFoundError, ValidationError } from '@/util/errors'
import {
  mergeSealedAnswers,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type ClarifyQuestionScope,
} from '@agent-workflow/shared'

export interface SealRoundQuestionsArgs {
  db: DbClient
  /** The clarify round's intermediary node_run id (= clarify_rounds.intermediaryNodeRunId
   *  = task_questions.originNodeRunId). Locates the round to seal into. */
  originNodeRunId: string
  /** The answers to seal in THIS call (a subset of the round's questions, or all of
   *  them). Sealed + merged into the round's answers_json; only known question ids are
   *  honored (unknowns dropped, matching sealAnswersServerSide). */
  answers: ClarifyAnswer[]
  /** Optional per-question scope choice (cross rounds only — chosen at answer time).
   *  Merged into the round's question_scopes_json so the reconcile designer gate can
   *  see it. Ignored for self rounds (no designer). */
  scopes?: Record<string, ClarifyQuestionScope>
  /** Audit-only setter id (RFC-099 — NEVER enters an agent prompt). Stamped on the
   *  sealed entries' sealed_by and, when the round flips, on the round's answered_by. */
  sealedBy?: string
  now?: () => number
}

export interface SealRoundQuestionsResult {
  /** Question ids sealed by THIS call (after dropping unknowns + de-dup). */
  sealedQuestionIds: string[]
  /** True when, after this call, EVERY question of the round is sealed → the round was
   *  flipped to 'answered'. False = partial seal (round stays 'awaiting_human'). */
  roundFullySealed: boolean
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

/** RFC-128 §7/§10 — seal a subset of a clarify round's questions (control channel; no
 *  rerun mint). The whole sequence runs in ONE dbTxSync (P2-1): the round + entries are
 *  re-read inside the transaction (no TOCTOU) and all writes commit atomically. Async
 *  signature, fully-synchronous body (dbTxSync requires it) — `await`-able by callers and
 *  rejects cleanly when a guard throws. See the file header for the full contract. */
export async function sealRoundQuestions(
  args: SealRoundQuestionsArgs,
): Promise<SealRoundQuestionsResult> {
  const ts = (args.now ?? Date.now)()
  return dbTxSync(args.db, (tx): SealRoundQuestionsResult => {
    // Re-read the round INSIDE the tx so a concurrent seal's committed answers/status are
    // observed (TOCTOU-free).
    const round = tx
      .select()
      .from(clarifyRounds)
      .where(eq(clarifyRounds.intermediaryNodeRunId, args.originNodeRunId))
      .all()[0]
    if (round === undefined) {
      throw new NotFoundError(
        'clarify-round-not-found',
        `no clarify_round for origin node_run ${args.originNodeRunId}`,
      )
    }
    // RFC-126: a terminal/aborted round is not sealable (it produces no actionable
    // entries; sealing it would resurrect a dead round).
    if (round.status === 'canceled' || round.status === 'abandoned') {
      throw new ConflictError(
        'clarify-round-terminal',
        `clarify_round ${round.id} is '${round.status}'; cannot seal questions on it`,
      )
    }

    const questions = parseQuestions(round.questionsJson)
    const questionIds = new Set(questions.map((q) => q.id))

    // Seal the passed answers (option-label forgery defense + unknown-question drop), then
    // keep only those that target a real question of this round.
    const sealedSubset = sealAnswersServerSide(questions, args.answers).filter((a) =>
      questionIds.has(a.questionId),
    )
    const sealingSet = new Set(sealedSubset.map((a) => a.questionId))
    if (sealingSet.size === 0) {
      throw new ValidationError(
        'clarify-seal-empty',
        'no sealable answers (the subset references no known question of this round)',
      )
    }

    // Which questions are ALREADY sealed: the whole round answered (all) OR an entry with
    // a sealed_at marker. A re-seal of any of those is rejected (seal-exactly-once). Read
    // inside the tx so the check + the stamp below are atomic (no double-seal race).
    const existingEntries = tx
      .select({ questionId: taskQuestions.questionId, sealedAt: taskQuestions.sealedAt })
      .from(taskQuestions)
      .where(eq(taskQuestions.originNodeRunId, args.originNodeRunId))
      .all()
    const alreadySealed = new Set<string>()
    if (round.status === 'answered') for (const q of questions) alreadySealed.add(q.id)
    for (const e of existingEntries) if (e.sealedAt !== null) alreadySealed.add(e.questionId)
    for (const id of sealingSet) {
      if (alreadySealed.has(id)) {
        throw new ConflictError(
          'clarify-question-already-sealed',
          `question '${id}' is already sealed; it cannot be sealed again`,
        )
      }
    }

    // (1) Merge the sealed subset into the round's answers_json (per-question merge-write).
    // No lockedIds needed here: the seal subset is disjoint from already-sealed ids
    // (rejected above), so it never overwrites a locked answer.
    const merged = mergeSealedAnswers(parseAnswersArray(round.answersJson), sealedSubset)
    const mergedJson = JSON.stringify(merged)

    // (2) Merge any per-question scope choice into the round's question_scopes_json
    // (P2-3: never drop a previously-stored scope).
    const mergedScopes = { ...parseScopes(round.questionScopesJson) }
    if (args.scopes) {
      for (const [qid, scope] of Object.entries(args.scopes)) {
        if ((scope === 'designer' || scope === 'questioner') && questionIds.has(qid)) {
          mergedScopes[qid] = scope
        }
      }
    }
    const scopesJson = Object.keys(mergedScopes).length > 0 ? JSON.stringify(mergedScopes) : null

    // (5) Flip the round → answered ONLY when EVERY question is now sealed.
    const newSealed = new Set<string>([...alreadySealed, ...sealingSet])
    const fullySealed = questions.every((q) => newSealed.has(q.id))

    // Write clarify_rounds (the SoT): merged answers + merged scopes; flip status only
    // when fully sealed. Keep status 'awaiting_human' on a partial seal (NEVER a new DB
    // 'partial' status — RFC-128 §2 / RFC-126).
    tx.update(clarifyRounds)
      .set({
        answersJson: mergedJson,
        questionScopesJson: scopesJson,
        ...(fullySealed
          ? {
              status: 'answered' as const,
              answeredAt: ts,
              ...(args.sealedBy !== undefined ? { answeredBy: args.sealedBy } : {}),
            }
          : {}),
      })
      .where(eq(clarifyRounds.id, round.id))
      .run()

    // Dual-write the legacy session table (RFC-058 keeps both in lockstep on the
    // overlapping columns) by the SHARED row id. crossClarifySessions has no answered_by
    // column (matches submitCrossClarifyAnswers), so we mirror answers + scopes + status +
    // answeredAt — the fields the dual-write-consistency nets assert.
    const legacySet = {
      answersJson: mergedJson,
      questionScopesJson: scopesJson,
      ...(fullySealed ? { status: 'answered' as const, answeredAt: ts } : {}),
    }
    if (round.kind === 'self') {
      tx.update(clarifySessions).set(legacySet).where(eq(clarifySessions.id, round.id)).run()
    } else {
      tx.update(crossClarifySessions)
        .set(legacySet)
        .where(eq(crossClarifySessions.id, round.id))
        .run()
    }

    // (3) Reconcile against the EFFECTIVE round (status reflects the flip above). P2-4(a):
    // designer entries appear only once the round is fully sealed (= answered); a partial
    // seal creates only questioner/self entries. Done on the SAME tx (dbTxSync can't nest).
    reconcileRoundEntriesTx(tx, {
      ...round,
      status: fullySealed ? 'answered' : round.status,
      answersJson: mergedJson,
      questionScopesJson: scopesJson,
      answeredAt: fullySealed ? ts : round.answeredAt,
    })

    // (4) Stamp sealed_at on the (question × role) entries sealed by THIS call that are
    // not yet stamped. Idempotent via IS NULL. (Designer entries created above for a
    // fully-sealed round derive `sealed` from round.status — no backfill needed.)
    tx.update(taskQuestions)
      .set({ sealedAt: ts, sealedBy: args.sealedBy ?? null, updatedAt: ts })
      .where(
        and(
          eq(taskQuestions.originNodeRunId, args.originNodeRunId),
          inArray(taskQuestions.questionId, [...sealingSet]),
          isNull(taskQuestions.sealedAt),
        ),
      )
      .run()

    return { sealedQuestionIds: [...sealingSet], roundFullySealed: fullySealed }
  })
}
