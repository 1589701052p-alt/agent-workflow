// RFC-128 P4 (T9) — centralized answer pane.
//
// Locks:
//   1. groupUnsealedQuestions oracle — only UNSEALED + clarify-backed questions,
//      grouped by originNodeRunId in stable order, deduped (NOT answerSummary-based).
//   2. isAnswerFilled oracle.
//   3. The dialog flattens every task's unsealed questions (grouped by round) into
//      QuestionForm blocks; the SINGLE submit button seals each round's filled subset
//      via POST /api/clarify/:id/answers with defer:true + a questionIds cap.
//   4. Submit is disabled until ≥1 answer is filled.
//   5. No unsealed questions → empty state.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { ClarifyRound } from '@agent-workflow/shared'
import { api } from '@/api/client'
import {
  CentralizedAnswerDialog,
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

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'nr_a',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'designer',
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
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: 'nr_src',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: null,
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
  test('keeps only unsealed clarify-backed questions, grouped by round in stable order', () => {
    const groups = groupUnsealedQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a' }),
      entry({ id: 'b', questionId: 'q2', originNodeRunId: 'nr_b' }),
      entry({ id: 'c', questionId: 'q3', originNodeRunId: 'nr_a' }),
      // sealed → excluded
      entry({ id: 'd', questionId: 'q4', originNodeRunId: 'nr_a', sealed: true }),
      // manual (no clarify round) → excluded
      entry({ id: 'e', questionId: 'q5', originNodeRunId: null, sourceKind: 'manual' }),
    ])
    expect(groups).toEqual([
      { originNodeRunId: 'nr_a', questionIds: ['q1', 'q3'] },
      { originNodeRunId: 'nr_b', questionIds: ['q2'] },
    ])
  })

  test('dedupes a questionId that appears under multiple role rows in one round', () => {
    const groups = groupUnsealedQuestions([
      entry({ id: 'a', questionId: 'q1', originNodeRunId: 'nr_a', roleKind: 'questioner' }),
      entry({ id: 'b', questionId: 'q1', originNodeRunId: 'nr_a', roleKind: 'designer' }),
    ])
    expect(groups).toEqual([{ originNodeRunId: 'nr_a', questionIds: ['q1'] }])
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
  test('no unsealed questions → empty state, submit disabled', async () => {
    renderDialog([entry({ id: 'a', sealed: true })], [])
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeTruthy())
    expect((screen.getByTestId('centralized-answer-submit') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })

  test('flattens 2 rounds, single submit seals each round subset with defer:true + questionIds cap', async () => {
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
    // Both rounds rendered as blocks with their question.
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
    })
    expect(calls['/api/clarify/nr_b/answers']).toMatchObject({
      defer: true,
      directive: 'continue',
      questionIds: ['q2'],
    })
    // Only filled answers are submitted (subset cap matches answers).
    expect((calls['/api/clarify/nr_a/answers'] as { answers: unknown[] }).answers).toHaveLength(1)
  })

  test('cross round sends questionScopes for the filled subset', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true } as never)
    vi.spyOn(api, 'put').mockResolvedValue(undefined as never)
    renderDialog(
      [
        entry({
          id: 'a',
          questionId: 'q1',
          originNodeRunId: 'nr_x',
          sourceKind: 'cross',
          roleKind: 'questioner',
        }),
      ],
      [round({ intermediaryNodeRunId: 'nr_x', kind: 'cross', targetConsumerNodeId: 'designer' })],
    )
    await waitFor(() => screen.getByTestId('clarify-question-q1'))
    // cross rounds render the scope segmented control (reuses .segmented).
    expect(screen.getByTestId('centralized-scope-q1')).toBeTruthy()
    fireEvent.click(within(screen.getByTestId('clarify-question-q1')).getAllByRole('radio')[0]!)
    const submit = screen.getByTestId('centralized-answer-submit') as HTMLButtonElement
    await waitFor(() => expect(submit.disabled).toBe(false))
    fireEvent.click(submit)
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0]![1]).toMatchObject({
      defer: true,
      questionIds: ['q1'],
      questionScopes: { q1: 'designer' },
    })
  })
})
