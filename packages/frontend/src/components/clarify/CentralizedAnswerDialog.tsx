// RFC-128 P4 (T9) — centralized answer pane.
//
// A single page (full-width Dialog) that flattens EVERY unsealed question that is still
// in the 待指派 ('pending') phase of a task, grouped by its originating clarify round, and
// seals them all with ONE submit button. Per user (2026-06-30): "页面和反问界面功能一致、只是只有
// 一个提交按钮" — so it reuses the /clarify primitives wholesale (QuestionForm /
// ClarifyQuestionHandler / the .segmented scope control / Card / Dialog / EmptyState
// / ErrorBanner / LoadingState) and only collapses the per-round submit into one.
//
// Channel = control (defer=true): each round's filled subset is POSTed to
// `/api/clarify/:nodeRunId/answers` with `defer:true` + a `questionIds` cap, which
// seals those questions into 待指派 WITHOUT minting a rerun. The board then picks an
// agent + dispatches. Which questions remain to answer is read from the per-question
// `sealed` DTO field (NOT answerSummary — Codex design gate F3: a partial round leaves
// answerSummary unreliable). RFC-128 P4/P5 (用户 2026-07-01): the pool is now EXPLICITLY
// gated to the 待指派 ('pending') phase — this replaces the earlier "unsealed ⟹ pending"
// assumption the code never actually enforced (an unsealed-but-dispatched entry could leak).

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type {
  ClarifyAnswer,
  ClarifyQuestionScope,
  ClarifyRound,
  SubmitClarifyAnswers,
} from '@agent-workflow/shared'
import { CLARIFY_QUESTION_SCOPE_DEFAULT } from '@agent-workflow/shared'
import { api, type ApiError } from '@/api/client'
import { Card } from '@/components/Card'
import { Dialog } from '@/components/Dialog'
import { EmptyState } from '@/components/EmptyState'
import { ErrorBanner } from '@/components/ErrorBanner'
import { LoadingState } from '@/components/LoadingState'
import { QuestionForm, type QuestionFormHandle } from '@/components/clarify/QuestionForm'
import { ClarifyQuestionHandler } from '@/components/clarify/ClarifyQuestionHandler'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { answersEqual, isAnswerFilled } from '@/lib/clarify/answers'
import { getClarifyDraft, setClarifyDraft } from '@/lib/clarify/draftStore'

const DRAFT_DEBOUNCE_MS = 500

export interface CentralizedAnswerGroup {
  originNodeRunId: string
  questionIds: string[]
}

/** Pure oracle (unit-tested): the task's UNSEALED clarify questions grouped by their
 *  originating clarify round (originNodeRunId), in stable first-appearance order.
 *
 *  RFC-128 P5-BC — the pane now surfaces SELF-clarify AND cross (questioner/designer) questions:
 *  the P4 designer-only filter (sourceKind === 'cross') is GONE. P5-BC's self/questioner park +
 *  dispatch path means a defer-sealed self/questioner question is NO LONGER stranded — it parks
 *  its home (loadUndispatchedSelfQuestionerTargets) until board dispatch mints the continuation.
 *  Cross questions get a per-question scope picker (designer ↔ questioner) below.
 *
 *  Excluded: already-sealed questions (`sealed` per-question DTO field, NOT
 *  `answerSummary !== null` — F3), manual questions (originNodeRunId null — the instruction
 *  IS the content, nothing to answer), and — RFC-128 P4/P5 (用户 2026-07-01) — any entry past
 *  the 待指派 ('pending') phase: the defer→待指派→dispatch control channel only applies before
 *  dispatch, so a staged/processing/awaiting_confirm/done entry is out. Dedup is by (round,
 *  questionId): a cross round's questioner + designer entries share a questionId → one render. */
export function groupUnsealedQuestions(entries: TaskQuestionEntry[]): CentralizedAnswerGroup[] {
  const order: string[] = []
  const byRound = new Map<string, string[]>()
  for (const e of entries) {
    if (e.sealed) continue
    if (e.originNodeRunId === null) continue
    // RFC-128 P4/P5 (用户 2026-07-01): pool is gated to the 待指派 ('pending') phase. The
    // control channel (defer → 待指派 → board dispatch) only applies BEFORE dispatch, so an
    // unsealed-but-past-pending entry (staged/processing/awaiting_confirm/done) is excluded.
    if (e.phase !== 'pending') continue
    let qids = byRound.get(e.originNodeRunId)
    if (qids === undefined) {
      qids = []
      byRound.set(e.originNodeRunId, qids)
      order.push(e.originNodeRunId)
    }
    if (!qids.includes(e.questionId)) qids.push(e.questionId)
  }
  return order.map((originNodeRunId) => ({
    originNodeRunId,
    questionIds: byRound.get(originNodeRunId)!,
  }))
}

/** RFC-128 (用户 2026-07-01) — keyboard-nav order oracle (unit-tested). Flattens EVERY round's
 *  questions into a single global navigation order of `${originNodeRunId}:${questionId}` keys,
 *  preserving round order (`groups`) and, WITHIN a round, that round's VISIBLE render order
 *  (reported by each RoundAnswerBlock — round.questions order filtered to the unsealed subset).
 *
 *  Why a reported per-round order instead of `groups[].questionIds`: the render order is the
 *  round's questionsJson order (RoundAnswerBlock filters round.questions), whereas a group's
 *  questionIds is task_questions storage order (listTaskQuestions has no ORDER BY) — the two can
 *  diverge. Keyboard "advance to next" must follow what the reviewer SEES, so we key off the
 *  reported render order; `groups[].questionIds` is the fallback until a round has reported (its
 *  first render), which keeps a just-mounted round navigable. */
export function flattenCentralizedNavKeys(
  groups: readonly CentralizedAnswerGroup[],
  roundVisibleOrder: ReadonlyMap<string, readonly string[]>,
): string[] {
  const keys: string[] = []
  for (const g of groups) {
    const reported = roundVisibleOrder.get(g.originNodeRunId)
    const qids = reported !== undefined && reported.length > 0 ? reported : g.questionIds
    for (const qid of qids) keys.push(`${g.originNodeRunId}:${qid}`)
  }
  return keys
}

/** One round's pending submission, reported up to the dialog by its RoundAnswerBlock. */
interface RoundSubmission {
  roundId: string
  iteration: number
  kind: ClarifyRound['kind']
  /** Filled answers only (a question with no pick / text is left for later). */
  answers: ClarifyAnswer[]
  /** questionIds of `answers` — the subset cap sent to the backend. */
  questionIds: string[]
  /** cross only — per-question scope for the filled questions. */
  questionScopes?: Record<string, ClarifyQuestionScope>
}

export interface CentralizedAnswerDialogProps {
  taskId: string
  open: boolean
  onClose: () => void
}

export function CentralizedAnswerDialog({ taskId, open, onClose }: CentralizedAnswerDialogProps) {
  const { t } = useTranslation()
  const qc = useQueryClient()

  const tqQuery = useQuery<TaskQuestionEntry[], ApiError>({
    queryKey: ['task-questions', taskId],
    queryFn: ({ signal }) => api.get(`/api/tasks/${taskId}/questions`, undefined, signal),
    enabled: open,
    retry: false,
  })
  const groups = useMemo(
    () => groupUnsealedQuestions(Array.isArray(tqQuery.data) ? tqQuery.data : []),
    [tqQuery.data],
  )

  // Per-round filled submissions, keyed by originNodeRunId. Children own their answer
  // state + draft autosave and report a compact submission up here (stable callback ⇒
  // no feedback render loop). Stale keys (a round that left `groups`) are ignored at
  // submit because we iterate `groups`, not the raw map.
  const [submissions, setSubmissions] = useState<Record<string, RoundSubmission>>({})
  const onSubmissionChange = useCallback((originNodeRunId: string, sub: RoundSubmission | null) => {
    setSubmissions((prev) => {
      if (sub === null) {
        if (prev[originNodeRunId] === undefined) return prev
        const next = { ...prev }
        delete next[originNodeRunId]
        return next
      }
      return { ...prev, [originNodeRunId]: sub }
    })
  }, [])

  const filledTotal = useMemo(
    () => groups.reduce((n, g) => n + (submissions[g.originNodeRunId]?.questionIds.length ?? 0), 0),
    [groups, submissions],
  )

  // RFC-128 (用户 2026-07-01) — cross-round keyboard navigation. The reference (/clarify page,
  // clarify.detail.tsx) drives QuestionForm digit/Enter hotkeys by passing each form a `ref`
  // (into a per-question Map) + an `onAdvance` that focuses the NEXT question. This pane omitted
  // both, so onAdvance was undefined → the hotkeys were a silent no-op. Here we rebuild the SAME
  // mechanism but GLOBAL: one Map spanning EVERY round's questions (keyed `${origin}:${qid}`),
  // navigating the flattened order across round boundaries, and focusing the submit button after
  // the very last question. QuestionForm itself is unchanged.
  const questionRefs = useRef<Map<string, QuestionFormHandle | null>>(new Map())
  const submitBtnRef = useRef<HTMLButtonElement | null>(null)
  // Each RoundAnswerBlock reports its VISIBLE question order (round.questions filtered), so the
  // flat nav order matches what the reviewer sees (see flattenCentralizedNavKeys). Written from a
  // child effect (ref only ⇒ no re-render / loop); stale rounds are ignored (advance iterates
  // `groups`).
  const roundOrderRef = useRef<Map<string, string[]>>(new Map())
  // After the LAST question we move focus to the submit button (so a follow-up Enter submits). But
  // a single-choice DIGIT key runs onChange→onAdvance in ONE keydown, so at advance time the just-
  // picked answer has NOT committed yet → `filledTotal` is stale → the submit button may still be
  // `disabled` (a disabled <button> silently ignores .focus()). So: focus it now IF already enabled,
  // else set this pending flag and let the effect below flush the focus once the answer commits and
  // the button enables. Ref (not state) ⇒ no extra render; the flush effect re-checks on filledTotal
  // change (the disabled→enabled trigger). Regression: digit-pick the ONLY/last question (its answer
  // is the first filled) still lands focus on submit.
  const pendingSubmitFocusRef = useRef(false)
  const focusSubmitButton = useCallback(() => {
    const btn = submitBtnRef.current
    if (btn !== null && !btn.disabled) {
      btn.focus()
      pendingSubmitFocusRef.current = false
    } else {
      pendingSubmitFocusRef.current = true
    }
  }, [])
  const registerQuestionRef = useCallback((key: string, handle: QuestionFormHandle | null) => {
    if (handle === null) questionRefs.current.delete(key)
    else questionRefs.current.set(key, handle)
  }, [])
  const reportRoundOrder = useCallback((originNodeRunId: string, questionIds: string[]) => {
    roundOrderRef.current.set(originNodeRunId, questionIds)
  }, [])
  const advanceFromQuestion = useCallback(
    (originNodeRunId: string, questionId: string) => {
      const keys = flattenCentralizedNavKeys(groups, roundOrderRef.current)
      const idx = keys.indexOf(`${originNodeRunId}:${questionId}`)
      if (idx === -1) return
      const nextKey = keys[idx + 1]
      if (nextKey !== undefined) {
        // Same-round next OR the first question of the next round — one flat order. Navigating to
        // ANOTHER question SUPERSEDES a pending last-question submit focus (the reviewer moved back
        // to answer an earlier question) — cancel it so the flush effect can't later steal focus.
        pendingSubmitFocusRef.current = false
        questionRefs.current.get(nextKey)?.focus()
      } else {
        // Last question of the last round → move focus onto the single submit button so a follow-up
        // Enter submits (mirrors clarify.detail.tsx's submitContinueRef). Deferred if still disabled.
        focusSubmitButton()
      }
    },
    [groups, focusSubmitButton],
  )
  // Editing a NON-last question also SUPERSEDES a pending last-question submit focus (the reviewer
  // went back to fill an earlier question — its answer commits + bumps filledTotal, which would
  // otherwise flush the stale pending focus onto submit, stealing it from where the reviewer is).
  // Editing the LAST question does NOT cancel — that's the "empty last → Enter → fill it → focus
  // submit" flush. Called from every QuestionForm's onChange (cheap: short-circuits when no pending).
  const notifyQuestionEdited = useCallback(
    (originNodeRunId: string, questionId: string) => {
      if (!pendingSubmitFocusRef.current) return
      const keys = flattenCentralizedNavKeys(groups, roundOrderRef.current)
      const lastKey = keys[keys.length - 1]
      if (`${originNodeRunId}:${questionId}` !== lastKey) pendingSubmitFocusRef.current = false
    },
    [groups],
  )
  // Flush a deferred submit-button focus once the button enables (filledTotal 0→N after the LAST
  // question's answer commits). No-op unless a last-question advance set the pending flag AND it
  // wasn't superseded (advanceFromQuestion / notifyQuestionEdited above) by moving to / editing
  // another question in the meantime.
  useEffect(() => {
    if (pendingSubmitFocusRef.current) focusSubmitButton()
  }, [filledTotal, focusSubmitButton])
  // Clear any pending submit focus when the dialog closes so a reopen never inherits a stale flag.
  useEffect(() => {
    if (!open) pendingSubmitFocusRef.current = false
  }, [open])

  const submitMut = useMutation<void, Error, void>({
    mutationFn: async () => {
      const targets = groups
        .map((g) => ({ originNodeRunId: g.originNodeRunId, sub: submissions[g.originNodeRunId] }))
        .filter(
          (x): x is { originNodeRunId: string; sub: RoundSubmission } =>
            x.sub !== undefined && x.sub.questionIds.length > 0,
        )
      const results = await Promise.allSettled(
        targets.map(async ({ originNodeRunId, sub }) => {
          const body: SubmitClarifyAnswers = {
            answers: sub.answers,
            questionIds: sub.questionIds,
            directive: 'continue',
            // Control channel: seal into 待指派 without minting a rerun / resuming.
            defer: true,
            ifMatchIteration: sub.iteration,
          }
          if (sub.kind === 'cross' && sub.questionScopes !== undefined) {
            body.questionScopes = sub.questionScopes
          }
          await api.post(`/api/clarify/${originNodeRunId}/answers`, body)
        }),
      )
      const failed = results.find((r) => r.status === 'rejected')
      if (failed !== undefined) {
        const reason = (failed as PromiseRejectedResult).reason
        throw reason instanceof Error ? reason : new Error(String(reason))
      }
    },
    onSuccess: () => {
      // Sealed questions leave the unsealed pool (board / pane / badge) + each round
      // detail flips its draft → answer. useTaskSync also refreshes via clarify.* WS.
      void qc.invalidateQueries({ queryKey: ['task-questions', taskId] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'list'] })
      void qc.invalidateQueries({ queryKey: ['clarify', 'pending-count'] })
      for (const g of groups) {
        void qc.invalidateQueries({ queryKey: ['clarify', 'detail', g.originNodeRunId] })
      }
      onClose()
    },
  })

  let body: ReactNode
  if (tqQuery.isLoading) {
    body = <LoadingState />
  } else if (tqQuery.error !== null && tqQuery.error !== undefined) {
    body = <ErrorBanner error={tqQuery.error} />
  } else if (groups.length === 0) {
    body = <EmptyState title={t('taskQuestions.answerPaneEmpty')} />
  } else {
    body = (
      <div className="centralized-answer">
        <p className="muted" data-testid="centralized-answer-hint">
          {t('taskQuestions.answerPaneHint')}
        </p>
        {groups.map((g) => (
          <RoundAnswerBlock
            key={g.originNodeRunId}
            taskId={taskId}
            originNodeRunId={g.originNodeRunId}
            unsealedQuestionIds={g.questionIds}
            disabled={submitMut.isPending}
            onSubmissionChange={onSubmissionChange}
            registerQuestionRef={registerQuestionRef}
            reportRoundOrder={reportRoundOrder}
            onAdvance={advanceFromQuestion}
            onQuestionEdited={notifyQuestionEdited}
          />
        ))}
        {submitMut.error !== null && submitMut.error !== undefined && (
          <ErrorBanner error={submitMut.error} />
        )}
      </div>
    )
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('taskQuestions.answerPaneTitle')}
      size="lg"
      data-testid="centralized-answer-dialog"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button
            ref={submitBtnRef}
            type="button"
            className="btn btn--primary"
            disabled={filledTotal === 0 || submitMut.isPending}
            onClick={() => submitMut.mutate()}
            data-testid="centralized-answer-submit"
          >
            {filledTotal > 0
              ? t('taskQuestions.answerPaneSubmitCount', { count: filledTotal })
              : t('taskQuestions.answerPaneSubmit')}
          </button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}

interface RoundAnswerBlockProps {
  taskId: string
  originNodeRunId: string
  unsealedQuestionIds: string[]
  disabled: boolean
  onSubmissionChange: (originNodeRunId: string, sub: RoundSubmission | null) => void
  /** RFC-128 (用户 2026-07-01) cross-round keyboard nav — register/unregister this round's
   *  QuestionForm imperative handles into the dialog's global Map (key `${origin}:${qid}`). */
  registerQuestionRef: (key: string, handle: QuestionFormHandle | null) => void
  /** Report this round's VISIBLE question order up so the dialog's flat nav order matches the
   *  reviewer's render order (see flattenCentralizedNavKeys). */
  reportRoundOrder: (originNodeRunId: string, questionIds: string[]) => void
  /** Advance keyboard focus from (round, question) to the next question in the flattened global
   *  order (or the submit button at the very end). */
  onAdvance: (originNodeRunId: string, questionId: string) => void
  /** Notify the dialog that a question's answer changed, so it can cancel a stale pending
   *  last-question submit focus when a NON-last question is edited. */
  onQuestionEdited: (originNodeRunId: string, questionId: string) => void
}

/** One clarify round's answer block. Owns its local answer state + draft autosave (the
 *  SAME server draft endpoint the /clarify page uses, so drafts are shared across both
 *  entry points) and reports its filled subset up. RFC-128 P5-BC: a CROSS round renders a
 *  per-question scope picker (designer ↔ questioner) — both routes now defer-dispatch via the
 *  board (designer via §18, questioner via the P5-BC self/questioner park). A SELF round has
 *  no scope (the asking agent is its own consumer). */
function RoundAnswerBlock({
  taskId,
  originNodeRunId,
  unsealedQuestionIds,
  disabled,
  onSubmissionChange,
  registerQuestionRef,
  reportRoundOrder,
  onAdvance,
  onQuestionEdited,
}: RoundAnswerBlockProps) {
  const { t } = useTranslation()
  const roundQuery = useQuery<ClarifyRound, ApiError>({
    queryKey: ['clarify', 'detail', originNodeRunId],
    queryFn: ({ signal }) => api.get(`/api/clarify/${originNodeRunId}`, undefined, signal),
    retry: false,
  })
  const round = roundQuery.data
  const isCross = round?.kind === 'cross'

  const unsealedSet = useMemo(() => new Set(unsealedQuestionIds), [unsealedQuestionIds])
  const visibleQuestions = useMemo(
    () => (round?.questions ?? []).filter((q) => unsealedSet.has(q.id)),
    [round?.questions, unsealedSet],
  )

  // Report this round's visible render order up for the dialog's cross-round nav order. Ref-only
  // write in the parent (no state) ⇒ no re-render / loop. Runs whenever the visible set changes.
  useEffect(() => {
    reportRoundOrder(
      originNodeRunId,
      visibleQuestions.map((q) => q.id),
    )
  }, [originNodeRunId, visibleQuestions, reportRoundOrder])

  const [answers, setAnswers] = useState<Record<string, ClarifyAnswer>>({})
  // RFC-128 P5-BC: per-question scope for a CROSS round (designer ↔ questioner). Defaults to
  // designer (CLARIFY_QUESTION_SCOPE_DEFAULT) — the user toggles to route a question to the
  // questioner. Empty / unused for a self round.
  const [scopes, setScopes] = useState<Record<string, ClarifyQuestionScope>>({})
  const [seeded, setSeeded] = useState(false)
  // Mirrors the last server-acknowledged draft per question, so the autosave only PUTs
  // the questions that actually changed (RFC-099 per-question last-write-wins).
  const serverDraftRef = useRef<Record<string, ClarifyAnswer>>({})
  const serverDraftDisabledRef = useRef(false)
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Seed once the round loads: server drafts (collaborative SoT, shared with /clarify)
  // win; the local IDB draft is the offline fallback when there's no server draft.
  useEffect(() => {
    if (round === undefined || seeded) return
    const fresh: Record<string, ClarifyAnswer> = {}
    for (const q of visibleQuestions) {
      fresh[q.id] = {
        questionId: q.id,
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
      }
    }
    const finalize = () => {
      serverDraftRef.current = { ...fresh }
      setAnswers(fresh)
      setSeeded(true)
    }
    const serverDrafts = round.draftAnswers ?? null
    if (serverDrafts !== null && Object.keys(serverDrafts).length > 0) {
      for (const [qid, v] of Object.entries(serverDrafts)) {
        if (fresh[qid] !== undefined) {
          fresh[qid] = {
            questionId: qid,
            selectedOptionIndices: v.selectedOptionIndices ?? [],
            selectedOptionLabels: [],
            customText: v.customText ?? '',
          }
        }
      }
      finalize()
      return
    }
    let cancelled = false
    void getClarifyDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId: round.id })
      .then((stored) => {
        if (cancelled || stored === null) return
        for (const a of stored) {
          if (fresh[a.questionId] !== undefined) fresh[a.questionId] = a
        }
      })
      .finally(() => {
        if (!cancelled) finalize()
      })
    return () => {
      cancelled = true
    }
  }, [round, seeded, visibleQuestions, taskId, originNodeRunId])

  // Debounced draft autosave — one server PUT per changed question (shared key with
  // /clarify) + an IDB mirror. Only while the round is still awaiting answers.
  useEffect(() => {
    if (round === undefined || !seeded || round.status !== 'awaiting_human') return
    if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    const roundId = round.id
    draftTimerRef.current = setTimeout(() => {
      const arr = visibleQuestions.map(
        (q) =>
          answers[q.id] ?? {
            questionId: q.id,
            selectedOptionIndices: [],
            selectedOptionLabels: [],
            customText: '',
          },
      )
      const puts: Array<Promise<unknown>> = []
      if (!serverDraftDisabledRef.current) {
        for (const a of arr) {
          const prev = serverDraftRef.current[a.questionId]
          if (prev !== undefined && answersEqual(prev, a)) continue
          serverDraftRef.current[a.questionId] = a
          puts.push(
            api
              .put(`/api/clarify/${originNodeRunId}/draft`, {
                roundId,
                questionId: a.questionId,
                selectedOptionIndices: a.selectedOptionIndices,
                customText: a.customText,
              })
              .catch(() => {
                // 403 (not a member) / 409 (round sealed under us) — stop hammering;
                // the IDB mirror keeps working locally.
                serverDraftDisabledRef.current = true
              }),
          )
        }
      }
      void Promise.allSettled([
        setClarifyDraft({ taskId, intermediaryNodeRunId: originNodeRunId, roundId }, arr),
        ...puts,
      ])
    }, DRAFT_DEBOUNCE_MS)
    return () => {
      if (draftTimerRef.current !== null) clearTimeout(draftTimerRef.current)
    }
  }, [answers, seeded, round, visibleQuestions, taskId, originNodeRunId])

  // Report the filled subset up so the dialog's single submit can collect it.
  useEffect(() => {
    if (round === undefined || !seeded) {
      onSubmissionChange(originNodeRunId, null)
      return
    }
    const filled = visibleQuestions
      .map((q) => answers[q.id])
      .filter((a): a is ClarifyAnswer => isAnswerFilled(a))
    if (filled.length === 0) {
      onSubmissionChange(originNodeRunId, null)
      return
    }
    const questionIds = filled.map((a) => a.questionId)
    const sub: RoundSubmission = {
      roundId: round.id,
      iteration: round.iteration,
      kind: round.kind,
      answers: filled,
      questionIds,
    }
    // RFC-128 P5-BC: send the per-question scope the user chose (default designer). A
    // designer-scope question → §18 designer dispatch; a questioner-scope question → P5-BC
    // self/questioner park + dispatch. Self rounds carry no scope.
    if (round.kind === 'cross') {
      const qs: Record<string, ClarifyQuestionScope> = {}
      for (const qid of questionIds) qs[qid] = scopes[qid] ?? CLARIFY_QUESTION_SCOPE_DEFAULT
      sub.questionScopes = qs
    }
    onSubmissionChange(originNodeRunId, sub)
  }, [answers, scopes, seeded, round, visibleQuestions, originNodeRunId, onSubmissionChange])

  // Drop this round's contribution when it unmounts (left `groups`).
  useEffect(
    () => () => onSubmissionChange(originNodeRunId, null),
    [originNodeRunId, onSubmissionChange],
  )

  const header =
    round === undefined
      ? originNodeRunId
      : isCross
        ? t('crossClarify.contextCard', { name: round.askingNodeId, n: round.iteration })
        : t('clarify.detail.contextCard', { name: round.askingNodeId, n: round.iteration })

  return (
    <Card data-testid={`centralized-round-${originNodeRunId}`}>
      <div className="card__title">{header}</div>
      {roundQuery.isLoading && <LoadingState />}
      {roundQuery.error !== null && roundQuery.error !== undefined && (
        <ErrorBanner error={roundQuery.error} />
      )}
      {round !== undefined &&
        visibleQuestions.map((q, idx) => {
          const a = answers[q.id]
          if (a === undefined) return null
          return (
            <div key={q.id} className="clarify-question-wrapper" data-question-wrapper-id={q.id}>
              {/* designer-domain reassign picker — scoped to THIS round (Codex P2-2) so it
                  never matches a sibling round's designer entry that reused the same id;
                  self-degrades to null until the question is sealed (post-seal, on the board). */}
              <ClarifyQuestionHandler
                taskId={taskId}
                questionId={q.id}
                originNodeRunId={originNodeRunId}
              />
              {/* RFC-128 P5-BC: per-question scope picker for a CROSS round (designer ↔
                  questioner). Mirrors the /clarify .segmented control; reuses its i18n. A self
                  round renders none (the asking agent is its own consumer). */}
              {isCross && (
                <div
                  className="segmented"
                  role="radiogroup"
                  aria-label={t('crossClarify.questionScope.label')}
                  data-testid={`centralized-scope-${q.id}`}
                >
                  {(['designer', 'questioner'] as const).map((mode) => {
                    const active = (scopes[q.id] ?? CLARIFY_QUESTION_SCOPE_DEFAULT) === mode
                    return (
                      <button
                        key={mode}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        className={
                          'segmented__option' + (active ? ' segmented__option--active' : '')
                        }
                        disabled={disabled}
                        onClick={() => setScopes((prev) => ({ ...prev, [q.id]: mode }))}
                      >
                        {mode === 'designer'
                          ? t('crossClarify.questionScope.designer')
                          : t('crossClarify.questionScope.questioner')}
                      </button>
                    )
                  })}
                </div>
              )}
              <QuestionForm
                ref={(h) => registerQuestionRef(`${originNodeRunId}:${q.id}`, h)}
                question={q}
                value={a}
                index={idx + 1}
                disabled={disabled}
                onChange={(next) => {
                  // Cancel a stale pending submit focus if this is a NON-last question (no-op for
                  // the last question → the fill-then-flush happy path is preserved).
                  onQuestionEdited(originNodeRunId, q.id)
                  setAnswers((prev) => ({ ...prev, [q.id]: next }))
                }}
                onAdvance={() => onAdvance(originNodeRunId, q.id)}
              />
            </div>
          )
        })}
    </Card>
  )
}
