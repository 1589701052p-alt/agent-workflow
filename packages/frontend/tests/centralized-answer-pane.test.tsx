// RFC-128 P4 (T9) — centralized answer pane.
//
// Locks:
//   1. groupUnsealedQuestions oracle — only UNSEALED + clarify-backed + DESIGNER-mainline
//      (cross) questions, grouped by originNodeRunId in stable order, deduped. Self-clarify
//      is excluded (Codex P1-2: defer-sealing self/questioner work would strand it pre-P5).
//   2. isAnswerFilled oracle.
//   3. The dialog flattens the task's answerable questions (grouped by round) into
//      QuestionForm blocks; the SINGLE submit button seals each round's filled subset via
//      POST /api/clarify/:id/answers with defer:true + questionIds cap + designer scope.
//   4. Submit is disabled until ≥1 answer is filled.
//   5. No answerable questions → empty state.
//   6. Designer mainline — NO scope picker is rendered (Codex P1-2); cross questions always
//      seal to the designer scope. Self-clarify rounds don't enter the pane.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClarifyRound } from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  CentralizedAnswerDialog,
  flattenCentralizedNavKeys,
  groupUnsealedQuestions,
} from '@/components/clarify/CentralizedAnswerDialog'
import { isAnswerFilled } from '@/lib/clarify/answers'
import type { TaskQuestionEntry } from '@/components/tasks/TaskQuestionList'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // Catch-all so the post-submit invalidation refetch resolves quietly (the queries
  // under test are seeded with staleTime:Infinity, so this only serves stray refetches).
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
  )
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

// Default = an unsealed CROSS (designer-mainline) question — what the pane handles.
const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'nr_a',
  sourceKind: 'cross',
  roleKind: 'questioner',
  sourceNodeId: 'questioner',
  defaultTargetNodeId: 'designer',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'designer',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  sealed: false,
  answerSummary: null,
  ...over,
})

function round(over: Partial<ClarifyRound> & { intermediaryNodeRunId: string }): ClarifyRound {
  return {
    id: `rnd_${over.intermediaryNodeRunId}`,
    taskId: 'task-1',
    kind: 'cross',
    askingNodeId: 'questioner',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'q1',
        title: 'Pick DB',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'Postgres', description: '', recommended: false, recommendationReason: '' },
          { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ],
    status: 'awaiting_human',
    directive: null,
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    questionScopes: null,
    createdAt: 0,
    answeredAt: null,
    answeredBy: null,
    draftAnswers: null,
    ...over,
  }
}

/** A single-choice question with two options (digit '1' picks option 0). */
function singleQ(id: string, title = `Q ${id}`): ClarifyRound['questions'][number] {
  return {
    id,
    title,
    kind: 'single',
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function renderDialog(entries: TaskQuestionEntry[], rounds: ClarifyRound[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  qc.setQueryData(['tasks', 'task-1', 'snapshot'], { workflowSnapshot: { nodes: [] } })
  for (const r of rounds) {
    qc.setQueryData(['clarify', 'detail', r.intermediaryNodeRunId], r)
  }
  return render(
    <QueryClientProvider client={qc}>
      <CentralizedAnswerDialog taskId="task-1" open onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('groupUnsealedQuestions (oracle)', () => {
  test('keeps unsealed clarify-backed questions — self AND cross (RFC-128 P5-BC), grouped by round', () => {
    const groups = groupUnsealedQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
      entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b' }),
      entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_a' }),
      // sealed → excluded
      entry({ id: 'd', questionId: 'q4', originNodeRunId: 'nr_a', sealed: true }),
      // manual (no clarify round) → excluded
      entry({ id: 'e', questionId: 'q5', originNodeRunId: null, sourceKind: 'manual' }),
      // RFC-128 P5-BC: self-clarify is NOW included (park + dispatch path, no longer stranded).
      entry({
        id: 'f',
        questionId: 'q6',
        originNodeRunId: 'nr_self',
        sourceKind: 'self',
        roleKind: 'self',
      }),
    ])
    expect(groups).toEqual([
      { originNodeRunId: 'nr_a', questionIds: ['q1', 'q3'] },
      { originNodeRunId: 'nr_b', questionIds: ['q2'] },
      { originNodeRunId: 'nr_self', questionIds: ['q6'] },
    ])
  })

  test('dedupes a questionId that appears under multiple role rows in one round', () => {
    const groups = groupUnsealedQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', roleKind: 'questioner' }),
      entry({ id: 'b', questionId: 'q1', originNodeRunId: 'nr_a', roleKind: 'designer' }),
    ])
    expect(groups).toEqual([{ originNodeRunId: 'nr_a', questionIds: ['q1'] }])
  })

  // RFC-128 P4/P5 (用户 2026-07-01) — the pool tightens to 待指派 (pending) only. An unsealed but
  // non-pending entry (staged/processing/awaiting_confirm/done) is EXCLUDED: the control channel
  // (defer → 待指派 → board dispatch) only applies BEFORE dispatch. Locks the new phase gate.
  test('只纳 pending 待指派：非 pending 的未 seal 条目被排除', () => {
    const groups = groupUnsealedQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', phase: 'pending' }),
      entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b', phase: 'staged' }),
      entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_c', phase: 'processing' }),
      entry({ id: 'd', questionId: 'q4', originNodeRunId: 'nr_d', phase: 'awaiting_confirm' }),
      entry({ id: 'e', questionId: 'q5', originNodeRunId: 'nr_e', phase: 'done' }),
    ])
    expect(groups).toEqual([{ originNodeRunId: 'nr_a', questionIds: ['q1'] }])
  })
})

// RFC-128 (用户 2026-07-01) — cross-round keyboard-nav order oracle. Locks: flatten in group
// (round) order; within a round follow the REPORTED render order; fall back to group.questionIds
// when a round hasn't reported yet.
describe('flattenCentralizedNavKeys (oracle)', () => {
  test('flattens rounds in group order + questions in reported render order (across boundaries)', () => {
    const groups = [
      { originNodeRunId: 'nr_a', questionIds: ['q1', 'q2'] },
      { originNodeRunId: 'nr_b', questionIds: ['q3'] },
    ]
    const reported = new Map<string, string[]>([
      ['nr_a', ['q1', 'q2']],
      ['nr_b', ['q3']],
    ])
    expect(flattenCentralizedNavKeys(groups, reported)).toEqual(['nr_a:q1', 'nr_a:q2', 'nr_b:q3'])
  })

  test('reported render order OVERRIDES group storage order; unreported round falls back to group', () => {
    const groups = [{ originNodeRunId: 'nr_a', questionIds: ['q1', 'q2'] }]
    // Reported order is reversed vs storage → nav follows what the reviewer sees.
    expect(flattenCentralizedNavKeys(groups, new Map([['nr_a', ['q2', 'q1']]]))).toEqual([
      'nr_a:q2',
      'nr_a:q1',
    ])
    // A just-mounted round that hasn't reported yet stays navigable via group.questionIds.
    expect(flattenCentralizedNavKeys(groups, new Map())).toEqual(['nr_a:q1', 'nr_a:q2'])
  })
})

describe('isAnswerFilled (oracle)', () => {
  test('true for an option pick or custom text; false for empty / undefined', () => {
    const base = {
      questionId: 'q',
      selectedOptionIndices: [],
      selectedOptionLabels: [],
      customText: '',
    }
    expect(isAnswerFilled(undefined)).toBe(false)
    expect(isAnswerFilled(base)).toBe(false)
    expect(isAnswerFilled({ ...base, selectedOptionIndices: [0] })).toBe(true)
    expect(isAnswerFilled({ ...base, customText: 'x' })).toBe(true)
  })
})

describe('CentralizedAnswerDialog', () => {
  test('no answerable questions → empty state, submit disabled', async () => {
    renderDialog([entry({ id: 'a', sealed: true })], [])
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy())
    expect((screen.getByTestId('centralized-answer-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  test('self-clarify rounds ARE included in the pane (RFC-128 P5-BC)', async () => {
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_x' }),
        entry({
          id: 'b',
          questionId: 'qs',
          originNodeRunId: 'nr_self',
          sourceKind: 'self',
          roleKind: 'self',
        }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_x' }),
        round({
          intermediaryNodeRunId: 'nr_self',
          kind: 'self',
          askingNodeId: 'designer',
          targetConsumerNodeId: null,
          questions: [
            {
              id: 'qs',
              title: 'Self question',
              kind: 'single',
              recommended: false,
              options: [
                { label: 'A', description: '', recommended: false, recommendationReason: '' },
                { label: 'B', description: '', recommended: false, recommendationReason: '' },
              ],
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('centralized-round-nr_x'))
    // RFC-128 P5-BC: the self-clarify round NOW renders a block (it parks + board-dispatches).
    await waitFor(() => screen.getByTestId('centralized-round-nr_self'))
    // A self round renders NO scope picker (the asking agent is its own consumer).
    await waitFor(() => screen.getByTestId('clarify-question-qs'))
    expect(screen.queryByTestId('centralized-scope-qs')).toBeNull()
  })

  test('flattens 2 rounds, single submit seals each round subset (defer + questionIds + designer scope)', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b' }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_a' }),
        round({
          intermediaryNodeRunId: 'nr_b',
          questions: [
            {
              id: 'q2',
              title: 'Pick lang',
              kind: 'single',
              recommended: false,
              options: [
                { label: 'TS', description: '', recommended: false, recommendationReason: '' },
                { label: 'Go', description: '', recommended: false, recommendationReason: '' },
              ],
            },
          ],
        }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    expect(screen.getByTestId('centralized-round-nr_a')).toBeTruthy()
    expect(screen.getByTestId('centralized-round-nr_b')).toBeTruthy()

    // Submit disabled before any answer is filled.
    expect((screen.getByTestId('centralized-answer-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )

    // Fill the first option of each question.
    fireEvent.click(within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')[0]!)
    fireEvent.click(within(screen.getByTestId('clarify-question-q2')).getAllByRole('radio')[0]!)

    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    const calls = Object.fromEntries(post.mock.calls.map((c) => [c[0], c[1]]))
    expect(calls['/api/clarify/nr_a/answers']).toMatchObject({
      defer: true,
      directive: 'continue',
      questionIds: ['q1'],
      questionScopes: { q1: 'designer' },
    })
    expect(calls['/api/clarify/nr_b/answers']).toMatchObject({
      defer: true,
      directive: 'continue',
      questionIds: ['q2'],
      questionScopes: { q2: 'designer' },
    })
    // Only filled answers are submitted (subset cap matches answers).
    expect((calls['/api/clarify/nr_a/answers'] as { answers: unknown[] }).answers).toHaveLength(1)
  })

  test('cross round renders the scope picker; default seals designer, toggling routes to questioner (RFC-128 P5-BC)', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_x' })],
      [round({ intermediaryNodeRunId: 'nr_x' })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    // RFC-128 P5-BC: a cross round NOW offers a per-question scope picker (designer ↔ questioner).
    const scope = screen.getByTestId('centralized-scope-q1')
    expect(scope).toBeTruthy()
    // Toggle to the questioner scope (the 2nd radio), then fill the answer.
    fireEvent.click(within(scope).getAllByRole('radio')[1]!)
    fireEvent.click(within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')[0]!)
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]![1]).toMatchObject({
      defer: true,
      questionIds: ['q1'],
      questionScopes: { q1: 'questioner' },
    })
  })
})

// RFC-128 (用户 2026-07-01) — cross-round keyboard navigation. Regression: the pane's QuestionForm
// previously got NO `ref` + NO `onAdvance`, so the digit/Enter hotkeys (which call onAdvance) were a
// silent no-op. This wires a GLOBAL ref Map + advanceFromQuestion so Enter / a single-choice digit
// key advances focus to the next question — including across round boundaries — and to the submit
// button after the last question.
describe('CentralizedAnswerDialog — cross-round keyboard navigation', () => {
  // jsdom doesn't implement Element.prototype.scrollIntoView; QuestionForm's focus() handle calls
  // it, so patch it (per the QuestionForm focus test) — otherwise focus() throws.
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  test('Enter advances focus to the next question — same round AND across the round boundary; last → submit', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
        entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_b' }),
      ],
      [
        round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] }),
        round({ intermediaryNodeRunId: 'nr_b', questions: [singleQ('q3')] }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    await waitFor(() => screen.getByTestId('clarify-question-q3'))

    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')
    const q3 = screen.getByTestId('clarify-question-q3')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    // Fill one answer so the submit button is ENABLED — a disabled <button> cannot receive focus,
    // so the "last question → submit" hop only lands on an enabled button (nothing to submit ⇒
    // nothing to focus, which is fine).
    fireEvent.click(within(q1).getAllByRole('radio')[0]!)
    await waitFor(() => expect(submit.disabled).toBe(false))

    q1.focus()
    fireEvent.keyDown(q1, { key: 'Enter' })
    expect(document.activeElement).toBe(q2) // same-round advance (nr_a: q1 → q2)

    fireEvent.keyDown(q2, { key: 'Enter' })
    expect(document.activeElement).toBe(q3) // cross-round advance (nr_a → nr_b)

    fireEvent.keyDown(q3, { key: 'Enter' })
    expect(document.activeElement).toBe(submit) // last question → submit button
  })

  test('single-choice digit key picks the option AND advances to the next question', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')

    q1.focus()
    // Digit '1' picks option 0 of the single-choice question AND advances (QuestionForm contract).
    fireEvent.keyDown(q1, { key: '1' })
    expect((within(q1).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)
    expect(document.activeElement).toBe(q2)
  })

  // Codex impl-gate medium (2026-07-01): a single-choice DIGIT runs onChange→onAdvance in ONE
  // keydown, so at advance time the submit button is STILL disabled (filledTotal not yet re-rendered).
  // A synchronous focus() on a disabled <button> is ignored → the "last question → submit" hop
  // silently failed when the last question was the FIRST/only filled answer. The deferred-focus
  // effect must flush the focus once the button enables. These lock the one-question + answer-last
  // paths the earlier tests missed (they pre-filled another question, so submit was already enabled).
  test('ONE-question dialog: digit key picks the answer AND focus lands on the (now-enabled) submit', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' })],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true) // nothing filled yet → disabled

    q1.focus()
    fireEvent.keyDown(q1, { key: '1' }) // picks (first filled answer) + advances past the last question
    expect((within(q1).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)
    // The submit button enables (filledTotal 0→1) and the deferred focus flushes to it.
    await waitFor(() => expect(submit.disabled).toBe(false))
    await waitFor(() => expect(document.activeElement).toBe(submit))
  })

  test('answer-LAST: digit-pick the last question first (its answer is the first filled) → focus lands on submit', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    const q2 = screen.getByTestId('clarify-question-q2')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    q2.focus() // start on the LAST question with nothing filled → submit disabled
    fireEvent.keyDown(q2, { key: '1' }) // first filled answer IS the last question
    expect((within(q2).getAllByRole('radio')[0] as HTMLInputElement).checked).toBe(true)
    await waitFor(() => expect(submit.disabled).toBe(false))
    await waitFor(() => expect(document.activeElement).toBe(submit))
  })
})

// Codex impl-gate #2 (2026-07-01): the deferred submit-focus flag was too GLOBAL — once armed (empty
// last-question Enter), ANY later filledTotal change flushed it and stole focus to submit, even when
// the change came from editing a DIFFERENT question. These lock the scoping/cancel: a pending focus is
// superseded by navigating to / editing a non-last question, and reset on close.
describe('CentralizedAnswerDialog — pending submit-focus scoping / cancel', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
  })

  test('stale #1: empty last-question Enter → then answer an EARLIER question (digit) → focus stays on the advance target, NOT stolen to submit', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    // Empty LAST question → Enter arms a pending submit focus (button still disabled).
    q2.focus()
    fireEvent.keyDown(q2, { key: 'Enter' })
    expect(submit.disabled).toBe(true)

    // Reviewer goes BACK and answers an earlier question via digit → advances to q2 (its next).
    q1.focus()
    fireEvent.keyDown(q1, { key: '1' })
    // filledTotal is now >0 (submit enabled) but the stale pending was superseded → focus is on q2,
    // NOT stolen to submit.
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect(document.activeElement).toBe(q2)
    expect(document.activeElement).not.toBe(submit)
  })

  test('stale #2: empty last-question Enter → then fill an EARLIER question via custom-text → focus NOT stolen to submit', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
      [round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    const q1 = screen.getByTestId('clarify-question-q1')
    const q2 = screen.getByTestId('clarify-question-q2')
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    q2.focus()
    fireEvent.keyDown(q2, { key: 'Enter' }) // empty last → pending submit focus armed

    // Fill an EARLIER question via the custom-text path (Other row + type a char).
    fireEvent.click(within(q1).getByTestId('clarify-custom-radio'))
    fireEvent.change(within(q1).getByTestId('clarify-custom-textarea'), { target: { value: 'x' } })

    // The earlier edit superseded the pending focus → submit enables but is NOT auto-focused.
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect(document.activeElement).not.toBe(submit)
  })

  test('stale #3: close + reopen with an armed pending focus → no stale steal after reopen', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    qc.setQueryData(
      ['task-questions', 'task-1'],
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_a' }),
      ],
    )
    qc.setQueryData(
      ['clarify', 'detail', 'nr_a'],
      round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1'), singleQ('q2')] }),
    )
    const ui = (open: boolean) => (
      <QueryClientProvider client={qc}>
        <CentralizedAnswerDialog taskId="task-1" open={open} onClose={() => {}} />
      </QueryClientProvider>
    )
    const view = render(ui(true))
    await waitFor(() => screen.getByTestId('clarify-question-q2'))

    // Arm pending on the empty last question, then close (should reset the flag) + reopen.
    const q2 = screen.getByTestId('clarify-question-q2')
    q2.focus()
    fireEvent.keyDown(q2, { key: 'Enter' })
    view.rerender(ui(false))
    view.rerender(ui(true))
    await waitFor(() => screen.getByTestId('clarify-question-q2'))
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    // Fill the LAST question by MOUSE (does not re-arm pending). If close reset the flag, this must
    // NOT auto-steal focus to submit (the pre-fix bug carried the stale flag across reopen).
    fireEvent.click(within(screen.getByTestId('clarify-question-q2')).getAllByRole('radio')[0]!)
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect(document.activeElement).not.toBe(submit)
  })

  test('stale #4 (data refetch): pending armed → task-questions data adds a round (LAST key moves) while open → no stale steal', async () => {
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    })
    qc.setQueryData(
      ['task-questions', 'task-1'],
      [entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' })],
    )
    qc.setQueryData(
      ['clarify', 'detail', 'nr_a'],
      round({ intermediaryNodeRunId: 'nr_a', questions: [singleQ('q1')] }),
    )
    qc.setQueryData(
      ['clarify', 'detail', 'nr_b'],
      round({ intermediaryNodeRunId: 'nr_b', questions: [singleQ('q2')] }),
    )
    render(
      <QueryClientProvider client={qc}>
        <CentralizedAnswerDialog taskId="task-1" open onClose={() => {}} />
      </QueryClientProvider>,
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement

    // Arm pending on the empty last question q1 (it is currently the ONLY/last question → key nr_a:q1).
    const q1 = screen.getByTestId('clarify-question-q1')
    q1.focus()
    fireEvent.keyDown(q1, { key: 'Enter' })

    // Data refetch UNDER the open dialog: a NEW round (nr_b/q2) arrives → the flattened last key is
    // now nr_b:q2, so the armed key (nr_a:q1) no longer matches → superseded (fresh RoundAnswerBlock
    // seeds q2). Uses a new round to avoid the once-seeded round's added-question limitation.
    qc.setQueryData(
      ['task-questions', 'task-1'],
      [
        entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
        entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b' }),
      ],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q2'))

    // Fill the NEW last question q2 by MOUSE (notifyQuestionEdited would NOT cancel for the last
    // question, so this isolates the data-refetch supersede). The stale key (nr_a:q1) must NOT steal.
    fireEvent.click(within(screen.getByTestId('clarify-question-q2')).getAllByRole('radio')[0]!)
    await waitFor(() => expect(submit.disabled).toBe(false))
    expect(document.activeElement).not.toBe(submit)
  })
})
