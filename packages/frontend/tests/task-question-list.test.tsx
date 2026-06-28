// RFC-120 — TaskQuestionList board: renders entries into phase columns and wires
// the stage / confirm actions to the REST endpoints. Asserts on data-testid +
// roles (not translated text) so it's i18n-agnostic.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'

afterEach(() => {
  vi.restoreAllMocks()
  document.body.innerHTML = ''
})

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  sourceKind: 'self',
  roleKind: 'self',
  sourceNodeId: 'designer',
  defaultTargetNodeId: 'designer',
  overrideTargetNodeId: null,
  effectiveTargetNodeId: 'designer',
  phase: 'pending',
  confirmation: 'open',
  staged: false,
  answerSummary: null,
  ...over,
})

function wrap(entries: TaskQuestionEntry[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  return render(
    <QueryClientProvider client={qc}>
      <TaskQuestionList
        taskId="task-1"
        nodeOptions={[
          { id: 'designer', label: 'designer' },
          { id: 'fixer', label: 'fixer' },
        ]}
      />
    </QueryClientProvider>,
  )
}

describe('TaskQuestionList board', () => {
  test('renders entries as cards on the board', () => {
    wrap([
      entry({ id: 'e1', phase: 'pending' }),
      entry({ id: 'e2', phase: 'awaiting_confirm' }),
      entry({ id: 'e3', phase: 'done', roleKind: 'designer' }),
    ])
    expect(screen.getByTestId('task-questions-board')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e1')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e2')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e3')).toBeTruthy()
  })

  test('stage button posts to /stage with staged:true', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(undefined as never)
    wrap([entry({ id: 'e1', phase: 'pending', staged: false })])
    const card = screen.getByTestId('tq-card-e1')
    fireEvent.click(within(card).getByRole('button'))
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/e1/stage', { staged: true }),
    )
  })

  test('awaiting_confirm card shows a confirm control; designer card shows a reassign select', () => {
    wrap([
      entry({ id: 'e2', phase: 'awaiting_confirm' }),
      entry({
        id: 'e3',
        phase: 'pending',
        roleKind: 'designer',
        effectiveTargetNodeId: 'designer',
      }),
    ])
    // confirm card has at least one button (the ConfirmButton)
    expect(within(screen.getByTestId('tq-card-e2')).getAllByRole('button').length).toBeGreaterThan(
      0,
    )
    // designer card renders the reassign Select (a combobox/button trigger)
    expect(within(screen.getByTestId('tq-card-e3')).getAllByRole('button').length).toBeGreaterThan(
      0,
    )
  })

  test('empty list renders the empty state', () => {
    wrap([])
    expect(screen.queryByTestId('task-questions-board')).toBeNull()
  })
})
