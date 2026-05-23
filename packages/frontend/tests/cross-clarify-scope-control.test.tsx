// RFC-059 T6 — per-question scope control + footer hint + submit body + sealed
// chip + self-clarify exclusion.
//
// Locks:
//   1. cross-clarify + awaiting + N questions → renders N segmented scope
//      pickers, all defaulting to 'designer'.
//   2. clicking a question's "Asker" segment switches the footer hint to
//      'mixed' (one of the three submit-hint variants).
//   3. flipping every question to 'questioner' switches the footer hint to
//      'allQuestioner'.
//   4. submitting the form posts a body whose `questionScopes` reflects the
//      latest local state for every question.
//   5. sealed cross-clarify session (status='answered') renders read-only
//      scope chips (not the segmented), restored from `session.questionScopes`.
//   6. self-clarify session never renders the scope picker, never sends
//      `questionScopes` in submit body (byte-equivalent to RFC-058 baseline).

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
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function crossRound(overrides: Partial<ClarifyRound> = {}): ClarifyRound {
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
    ...overrides,
  }
}

function selfRound(overrides: Partial<ClarifyRound> = {}): ClarifyRound {
  return {
    id: 'rnd_self',
    taskId: 'task_a',
    kind: 'self',
    askingNodeId: 'designer',
    askingNodeRunId: 'nr_d',
    askingShardKey: null,
    intermediaryNodeId: 'c1',
    intermediaryNodeRunId: 'nr_self',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: null,
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'q1',
        title: 'Self first',
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
    ...overrides,
  }
}

function mockApi(opts: { round: ClarifyRound; capturePost?: { body?: unknown } }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      if (
        s.includes(`/api/clarify/${opts.round.intermediaryNodeRunId}`) &&
        !s.endsWith('/answers')
      ) {
        return new Response(JSON.stringify(opts.round), {
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
      if (s.endsWith('/answers')) {
        if (opts.capturePost && init?.body) {
          try {
            opts.capturePost.body = JSON.parse(String(init.body))
          } catch {
            /* ignore */
          }
        }
        return new Response(
          JSON.stringify({
            ok: true,
            kind: opts.round.kind,
            outcome: { kind: 'designer-rerun-triggered' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
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

describe('RFC-059 /clarify/$nodeRunId — per-question scope picker', () => {
  test('cross-clarify awaiting renders one Segmented per question; default is "designer"', async () => {
    mockApi({ round: crossRound() })
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-segmented-q1'))
    expect(screen.getByTestId('clarify-scope-segmented-q1')).not.toBeNull()
    expect(screen.getByTestId('clarify-scope-segmented-q2')).not.toBeNull()
    // Both questions default to 'designer'.
    expect(screen.getByTestId('clarify-scope-q1-designer').getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByTestId('clarify-scope-q2-designer').getAttribute('aria-checked')).toBe(
      'true',
    )
  })

  test('flipping ONE question to "questioner" → footer hint switches to "mixed"', async () => {
    mockApi({ round: crossRound() })
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('cross-clarify-submit-hint'))
    // Initially all designer → allDesigner hint.
    expect(screen.getByTestId('cross-clarify-submit-hint').getAttribute('data-hint-kind')).toBe(
      'crossClarify.submitHint.allDesigner',
    )
    fireEvent.click(screen.getByTestId('clarify-scope-q2-questioner'))
    await waitFor(() =>
      expect(screen.getByTestId('cross-clarify-submit-hint').getAttribute('data-hint-kind')).toBe(
        'crossClarify.submitHint.mixed',
      ),
    )
  })

  test('flipping ALL questions to "questioner" → hint switches to "allQuestioner"', async () => {
    mockApi({ round: crossRound() })
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('cross-clarify-submit-hint'))
    fireEvent.click(screen.getByTestId('clarify-scope-q1-questioner'))
    fireEvent.click(screen.getByTestId('clarify-scope-q2-questioner'))
    await waitFor(() =>
      expect(screen.getByTestId('cross-clarify-submit-hint').getAttribute('data-hint-kind')).toBe(
        'crossClarify.submitHint.allQuestioner',
      ),
    )
  })

  test('submit posts questionScopes mirroring local state', async () => {
    const captured: { body?: unknown } = {}
    mockApi({ round: crossRound(), capturePost: captured })
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-segmented-q1'))
    // Flip q2 to questioner; keep q1 at designer.
    fireEvent.click(screen.getByTestId('clarify-scope-q2-questioner'))
    fireEvent.click(screen.getByTestId('clarify-submit-continue'))
    await waitFor(() => {
      expect(captured.body).toBeDefined()
    })
    const body = captured.body as {
      questionScopes?: Record<string, string>
      directive?: string
    }
    expect(body.questionScopes).toEqual({ q1: 'designer', q2: 'questioner' })
    expect(body.directive).toBe('continue')
  })

  test('sealed cross-clarify (status=answered) shows readonly chips, not segmented', async () => {
    mockApi({
      round: crossRound({
        status: 'answered',
        answeredAt: 1_700_000_001_000,
        answeredBy: 'user1',
        directive: 'continue',
        questionScopes: { q1: 'designer', q2: 'questioner' },
        answers: [
          {
            questionId: 'q1',
            selectedOptionIndices: [0],
            selectedOptionLabels: ['A'],
            customText: '',
          },
          {
            questionId: 'q2',
            selectedOptionIndices: [1],
            selectedOptionLabels: ['B'],
            customText: '',
          },
        ],
      }),
    })
    renderRoute('/clarify/nr_cross')
    await waitFor(() => screen.getByTestId('clarify-scope-chip-q1'))
    expect(screen.getByTestId('clarify-scope-chip-q1').textContent).toContain('Designer')
    expect(screen.getByTestId('clarify-scope-chip-q2').textContent).toContain('Asker')
    // Segmented (editable) MUST NOT render in sealed state.
    expect(screen.queryByTestId('clarify-scope-segmented-q1')).toBeNull()
    expect(screen.queryByTestId('clarify-scope-segmented-q2')).toBeNull()
  })

  test('self-clarify (kind=self) does NOT render any scope picker / hint / sends no questionScopes', async () => {
    const captured: { body?: unknown } = {}
    mockApi({ round: selfRound(), capturePost: captured })
    renderRoute('/clarify/nr_self')
    await waitFor(() => screen.getByTestId('clarify-submit-continue'))
    // No scope UI for self.
    expect(screen.queryByTestId('clarify-scope-segmented-q1')).toBeNull()
    expect(screen.queryByTestId('clarify-scope-chip-q1')).toBeNull()
    expect(screen.queryByTestId('cross-clarify-submit-hint')).toBeNull()
    // Submit and check body has no questionScopes.
    fireEvent.click(screen.getByTestId('clarify-submit-continue'))
    await waitFor(() => {
      expect(captured.body).toBeDefined()
    })
    const body = captured.body as { questionScopes?: unknown; directive?: string }
    expect(body.questionScopes).toBeUndefined()
    expect(body.directive).toBe('continue')
  })
})
