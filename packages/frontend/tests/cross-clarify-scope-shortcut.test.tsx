// Cross-clarify Q / W keyboard shortcut + visual kbd-chip regression.
//
// Bug report: 在自动滚动的时候页面顶端没有上方问题归属的选项；同时需要 Q/W
// 快捷键选择问题归属（Q=设计者，W=反问者），选择后不跳下一题，且按钮文案
// 要带 (Q)/(W) 角标。
//
// Locks for the keyboard half:
//   1. cross-clarify + awaiting renders the (Q)/(W) hint chips inside the
//      segmented buttons.
//   2. pressing 'Q' on the page toggles the active question's scope to
//      'designer'; 'W' toggles to 'questioner'. (Q maps to designer / left,
//      W maps to questioner / right — matching the visual segmented order.)
//   3. the shortcut targets ONLY the question currently focused (walks up
//      from document.activeElement to [data-question-wrapper-id]).
//   4. the shortcut does NOT advance to the next question — neither focus
//      nor scroll moves; this lets reviewers toggle a single question's
//      scope while comparing tooltips.
//   5. while typing in the custom textarea (target=TEXTAREA) Q/W are
//      ignored so the user can type the literal letters.
//   6. the i18n keyboard hint paragraph appends the cross-clarify shortcut
//      reminder ('crossClarify.questionScope.shortcutHint').
//
// The scroll-target regression for the scope picker (issue #1 in the bug
// report) is locked in clarify-question-form.test.tsx ("when wrapped in
// .clarify-question-wrapper, scrollIntoView targets the wrapper") so the
// auto-scroll moves the wrapper (which contains the segmented above the
// card) instead of just the QuestionForm card.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { ClarifyRound } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { ClarifyDetailPage } from '../src/routes/clarify.detail'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  // jsdom doesn't implement scrollIntoView — silence it so QuestionForm's
  // focus() handle (and the imperative wrapper-scroll added in this PR)
  // don't throw under test.
  Element.prototype.scrollIntoView = vi.fn() as typeof Element.prototype.scrollIntoView
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function crossRound(): ClarifyRound {
  return {
    id: 'rnd_cross',
    taskId: 'task_a',
    kind: 'cross',
    askingNodeId: 'questioner',
    askingNodeRunId: 'nr_q',
    askingShardKey: null,
    intermediaryNodeId: 'cross1',
    intermediaryNodeRunId: 'nr_cross',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: 'designer',
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'q1',
        title: 'First',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'A', description: '', recommended: false, recommendationReason: '' },
          { label: 'B', description: '', recommended: false, recommendationReason: '' },
        ],
      },
      {
        id: 'q2',
        title: 'Second',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'A', description: '', recommended: false, recommendationReason: '' },
          { label: 'B', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ],
    directive: null,
    status: 'awaiting_human',
    sessionMode: null,
    designerRunTriggeredAt: null,
    abandonedAt: null,
    questionScopes: null,
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    answeredBy: null,
  }
}

function mockApi(round: ClarifyRound) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = typeof url === 'string' ? url : url.toString()
    if (s.includes(`/api/clarify/${round.intermediaryNodeRunId}`) && !s.endsWith('/answers')) {
      return new Response(JSON.stringify(round), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (s.includes('/api/clarify?')) {
      return new Response('[]', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  })
}

function renderRoute(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify/$nodeRunId',
    component: ClarifyDetailPage,
  })
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify',
    component: () => null,
  })
  const taskRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const tree = rootRoute.addChildren([detail, list, taskRoute])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('cross-clarify — Q/W scope shortcut', () => {
  test('segmented buttons render (Q)/(W) shortcut hint chips', async () => {
    mockApi(crossRound())
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-segmented-q1'))
    const designerKbd = screen.getByTestId('clarify-scope-q1-designer-kbd')
    const questionerKbd = screen.getByTestId('clarify-scope-q1-questioner-kbd')
    expect(designerKbd.textContent).toBe('Q')
    expect(questionerKbd.textContent).toBe('W')
  })

  test('keyboard hint paragraph appends the cross-clarify shortcut reminder', async () => {
    mockApi(crossRound())
    renderRoute('/clarify/nr_cross')
    const hint = await screen.findByTestId('clarify-keyboard-hint')
    // Either Chinese or English locale is acceptable; assert the load-bearing
    // tokens (Q and W) appear so the reviewer can discover the shortcut.
    expect(hint.textContent ?? '').toMatch(/Q\s*\/\s*W/)
  })

  test('W toggles the focused question scope to questioner; Q switches it back to designer', async () => {
    mockApi(crossRound())
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-segmented-q1'))
    // Initial focus settles on q1 via requestAnimationFrame.
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null
      expect(active?.dataset.questionId).toBe('q1')
    })
    // Default scope is 'designer' for both questions.
    expect(screen.getByTestId('clarify-scope-q1-designer').getAttribute('aria-checked')).toBe(
      'true',
    )
    // W on the page → q1 flips to questioner.
    fireEvent.keyDown(document.activeElement ?? window, { key: 'w' })
    await waitFor(() =>
      expect(screen.getByTestId('clarify-scope-q1-questioner').getAttribute('aria-checked')).toBe(
        'true',
      ),
    )
    // q2 untouched.
    expect(screen.getByTestId('clarify-scope-q2-designer').getAttribute('aria-checked')).toBe(
      'true',
    )
    // Q on the page → q1 flips back to designer.
    fireEvent.keyDown(document.activeElement ?? window, { key: 'q' })
    await waitFor(() =>
      expect(screen.getByTestId('clarify-scope-q1-designer').getAttribute('aria-checked')).toBe(
        'true',
      ),
    )
  })

  test('Q/W do not advance focus to the next question', async () => {
    mockApi(crossRound())
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-segmented-q1'))
    await waitFor(() => {
      const active = document.activeElement as HTMLElement | null
      expect(active?.dataset.questionId).toBe('q1')
    })
    fireEvent.keyDown(document.activeElement ?? window, { key: 'w' })
    await waitFor(() =>
      expect(screen.getByTestId('clarify-scope-q1-questioner').getAttribute('aria-checked')).toBe(
        'true',
      ),
    )
    // Focus stayed on q1 — the shortcut MUST NOT call onAdvance().
    const active = document.activeElement as HTMLElement | null
    expect(active?.dataset.questionId).toBe('q1')
  })

  test('Q/W typed inside the custom textarea are ignored as scope shortcuts', async () => {
    mockApi(crossRound())
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-segmented-q1'))
    // Open the custom row on q1 so its textarea becomes enabled, then focus it.
    fireEvent.click(screen.getAllByTestId('clarify-custom-radio')[0]!)
    const textareas = await screen.findAllByTestId('clarify-custom-textarea')
    const ta = textareas[0]! as HTMLTextAreaElement
    ta.focus()
    expect(document.activeElement).toBe(ta)
    fireEvent.keyDown(ta, { key: 'w' })
    // q1 stays on designer — the W keystroke was a textarea letter, not a shortcut.
    expect(screen.getByTestId('clarify-scope-q1-designer').getAttribute('aria-checked')).toBe(
      'true',
    )
  })
})
