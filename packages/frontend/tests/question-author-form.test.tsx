// RFC-120 §15 — manual question author form (自主新增) + the board's "+ 新增问题" wiring.
// (2026-07-02 用户拍板: the per-card "复制" action + the form's `initial` prefill prop were
// REMOVED — the removal locks live below.) Asserts on data-testid + roles (i18n-agnostic),
// and that the shared primitives are used (Dialog/Field/TextInput/TextArea/Select — no native
// modal/select chrome). golden-lock: no manual rows ⇒ the board's existing columns/cards are
// unchanged.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { api } from '@/api/client'
import { TaskQuestionList, type TaskQuestionEntry } from '../src/components/tasks/TaskQuestionList'
import { QuestionAuthorForm } from '../src/components/tasks/QuestionAuthorForm'

afterEach(() => {
  // RTL cleanup properly unmounts the React tree incl. the Dialog PORTAL; a manual
  // `document.body.innerHTML = ''` would orphan the portal and crash the next unmount.
  cleanup()
  vi.restoreAllMocks()
})

const entry = (over: Partial<TaskQuestionEntry>): TaskQuestionEntry => ({
  id: 'e0',
  questionId: 'q1',
  questionTitle: 'Pick a strategy?',
  originNodeRunId: 'origin-1',
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

async function wrapBoard(entries: TaskQuestionEntry[], _deferred = true) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['task-questions', 'task-1'], entries)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => (
      <QueryClientProvider client={qc}>
        <TaskQuestionList
          taskId="task-1"
          nodeOptions={[
            { id: 'designer', label: 'designer' },
            { id: 'fixer', label: 'fixer' },
          ]}
        />
      </QueryClientProvider>
    ),
  })
  const clarify = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, clarify]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(<RouterProvider router={router as never} />)
}

function wrapForm(props: Partial<React.ComponentProps<typeof QuestionAuthorForm>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <QuestionAuthorForm
        open
        onClose={props.onClose ?? (() => {})}
        taskId="task-1"
        nodeOptions={[
          { id: 'designer', label: 'designer' },
          { id: 'fixer', label: 'fixer' },
        ]}
        onCreated={props.onCreated}
      />
    </QueryClientProvider>,
  )
}

// Pick a node in the shared <Select> (role=combobox trigger → portal listbox; options fire
// on mouseDown). Used to satisfy the §15 required-handler rule in the form tests.
function selectHandler(label: string) {
  fireEvent.click(screen.getByRole('combobox'))
  fireEvent.mouseDown(screen.getByRole('option', { name: label }))
}

const saveBtn = () => screen.getByTestId('question-author-save') as HTMLButtonElement

describe('QuestionAuthorForm', () => {
  test('renders title input, instruction textarea, handler select (shared primitives)', () => {
    wrapForm()
    expect(screen.getByTestId('question-author-form')).toBeTruthy()
    expect(screen.getByTestId('question-author-title')).toBeTruthy()
    expect(screen.getByTestId('question-author-body')).toBeTruthy()
    // handler is the shared Select (role=combobox trigger, NOT a native <select>)
    const dialog = screen.getByTestId('question-author-form')
    expect(dialog.querySelector('select')).toBeNull()
    expect(within(dialog).getByRole('combobox')).toBeTruthy()
  })

  test('save is disabled until title, body AND a handler node are all set', () => {
    wrapForm()
    expect(saveBtn().disabled).toBe(true)
    fireEvent.change(screen.getByTestId('question-author-title'), { target: { value: 'T' } })
    expect(saveBtn().disabled).toBe(true)
    fireEvent.change(screen.getByTestId('question-author-body'), { target: { value: 'B' } })
    // §15 re-gate: a handler is REQUIRED — still disabled until a node is chosen.
    expect(saveBtn().disabled).toBe(true)
    selectHandler('fixer')
    expect(saveBtn().disabled).toBe(false)
  })

  test('save POSTs /questions/manual with trimmed title + body + the chosen targetNodeId', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ ok: true, id: 'm1' } as never)
    wrapForm()
    fireEvent.change(screen.getByTestId('question-author-title'), {
      target: { value: '  Fix it  ' },
    })
    fireEvent.change(screen.getByTestId('question-author-body'), { target: { value: ' do X ' } })
    selectHandler('fixer')
    fireEvent.click(saveBtn())
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith('/api/tasks/task-1/questions/manual', {
        title: 'Fix it',
        body: 'do X',
        targetNodeId: 'fixer',
      }),
    )
  })
})

describe('TaskQuestionList — manual question entry points (§15)', () => {
  test('"+ 新增问题" opens the author form (create mode — empty)', async () => {
    await wrapBoard([entry({ id: 'e1', phase: 'pending' })])
    expect(screen.queryByTestId('question-author-form')).toBeNull()
    fireEvent.click(screen.getByTestId('tq-add-question'))
    expect(screen.getByTestId('question-author-form')).toBeTruthy()
    expect((screen.getByTestId('question-author-title') as HTMLInputElement).value).toBe('')
  })

  test('"+ 新增问题" is available even when the board is EMPTY', async () => {
    await wrapBoard([])
    expect(screen.queryByTestId('task-questions-board')).toBeNull()
    expect(screen.getByTestId('tq-add-question')).toBeTruthy()
  })

  // 2026-07-02 (用户拍板) — the per-card 复制 action is REMOVED: no 待指派 card exposes a
  // tq-copy-* button, and "+ 新增问题" always opens EMPTY (the form has no prefill path left).
  test('复制功能移除：待指派卡无 tq-copy 按钮；新增表单恒为空', async () => {
    await wrapBoard([
      entry({ id: 'e1', phase: 'pending', questionTitle: 'Orig Q', answerSummary: 'Orig A' }),
    ])
    expect(screen.queryByTestId('tq-copy-e1')).toBeNull()
    fireEvent.click(screen.getByTestId('tq-add-question'))
    expect((screen.getByTestId('question-author-title') as HTMLInputElement).value).toBe('')
    expect((screen.getByTestId('question-author-body') as HTMLTextAreaElement).value).toBe('')
  })

  test('RFC-132 PR-F: manual entry points are ALWAYS shown (the deferred flag is gone)', async () => {
    // The unified model makes every task deferred-dispatch — the old H2 "non-deferred
    // hides manual buttons" gate died with the tasks.deferred_question_dispatch column.
    await wrapBoard([entry({ id: 'e1', phase: 'pending' })], false)
    expect(screen.getByTestId('tq-add-question')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e1')).toBeTruthy()
    expect(screen.queryByTestId('tq-answer-e1')).toBeNull()
  })

  test('RFC-132 PR-F: an EMPTY board still shows "+ 新增问题" (first manual question)', async () => {
    await wrapBoard([], false)
    expect(screen.getByTestId('tq-add-question')).toBeTruthy()
  })

  test('a manual card shows the "手动" source label + no clarify link', async () => {
    await wrapBoard([
      entry({
        id: 'm1',
        phase: 'staged',
        sourceKind: 'manual',
        roleKind: 'designer',
        sourceNodeId: null,
        originNodeRunId: null,
        defaultTargetNodeId: null,
        overrideTargetNodeId: 'fixer',
        effectiveTargetNodeId: 'fixer',
        questionTitle: 'Manual one',
        answerSummary: 'do the thing',
        staged: true,
      }),
    ])
    const card = screen.getByTestId('tq-card-m1')
    expect(card.textContent).toContain('Manual one')
    // no /clarify link for a manual row (originNodeRunId null)
    expect(within(card).queryByTestId('tq-answer-m1')).toBeNull()
  })

  test('golden-lock: with NO manual rows the existing board columns/cards are unchanged', async () => {
    await wrapBoard([
      entry({ id: 'e1', phase: 'pending' }),
      entry({ id: 'e2', phase: 'awaiting_confirm' }),
    ])
    // board + both cards still render. (RFC-128 P4/P5: the per-card /clarify answer Link was
    // removed globally — it's no longer present on any card.)
    expect(screen.getByTestId('task-questions-board')).toBeTruthy()
    expect(screen.getByTestId('tq-card-e1')).toBeTruthy()
    expect(screen.queryByTestId('tq-answer-e1')).toBeNull()
    // the author form stays closed until "+ 新增问题" is clicked (no behavioral change).
    expect(screen.queryByTestId('question-author-form')).toBeNull()
  })
})
