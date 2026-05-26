// RFC-056 PR-C T8 — locks /clarify/$nodeRunId detail page cross-clarify branch.
//
// 2026-05-26 update: unified the secondary "stop" button across self- and
// cross-clarify pages. Cross no longer has its own red Reject button; both
// pages render `clarify-submit-stop` (ghost) + share one confirm dialog
// `clarify-stop-modal`. The dialog's in-modal copy still differs (cross
// keeps the cross-loop persistence warning text via
// `crossClarify.rejectModal.{title,body,confirm}`).
//
// LOCKS:
//   1. Cross-clarify session renders the unified stop button
//      (data-testid='clarify-submit-stop').
//   2. Clicking stop opens the unified confirm modal
//      (data-testid='clarify-stop-modal').
//   3. Cross-clarify detail page surfaces the targetDesigner in the
//      context card.
//   4. Stop-modal Cancel closes without submitting; Confirm fires submit
//      with directive='stop'.
//
// Source-text grep guards at the bottom: the cross-specific i18n copy is
// still referenced (so we keep the stronger warning text), the unified
// testids reach the source file.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

const DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'clarify.detail.tsx')

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// RFC-058: legacy alias overrides for readability of older test cases.
type CrossLegacyOverrides = Partial<{
  crossClarifyNodeId: string
  crossClarifyNodeRunId: string
  sourceQuestionerNodeId: string
  sourceQuestionerNodeRunId: string
  targetDesignerNodeId: string | null
}> &
  Partial<ClarifyRound>

function crossSession(overrides: CrossLegacyOverrides = {}): ClarifyRound {
  const {
    crossClarifyNodeId,
    crossClarifyNodeRunId,
    sourceQuestionerNodeId,
    sourceQuestionerNodeRunId,
    targetDesignerNodeId,
    ...rest
  } = overrides
  return {
    id: 'sess_cross_1',
    taskId: 'task_a',
    kind: 'cross',
    askingNodeId: sourceQuestionerNodeId ?? 'questioner',
    askingNodeRunId: sourceQuestionerNodeRunId ?? 'nr_q_1',
    askingShardKey: null,
    intermediaryNodeId: crossClarifyNodeId ?? 'cross1',
    intermediaryNodeRunId: crossClarifyNodeRunId ?? 'nr_cross_1',
    intermediaryNodeTitle: null,
    targetConsumerNodeId: targetDesignerNodeId !== undefined ? targetDesignerNodeId : 'designer',
    loopIter: 0,
    iteration: 0,
    questions: [
      {
        id: 'q1',
        title: 'Why Redis?',
        kind: 'single',
        recommended: false,
        options: [
          { label: 'Cluster reuse', description: '', recommended: false, recommendationReason: '' },
          { label: 'Simplicity', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ],
    directive: null,
    status: 'awaiting_human',
    sessionMode: null,
    designerRunTriggeredAt: null,
    createdAt: 1_700_000_000_000,
    answeredAt: null,
    answeredBy: null,
    abandonedAt: null,
    questionScopes: null,
    ...rest,
  }
}

function mockApi(opts: {
  session: ClarifyRound
  peers?: Array<Record<string, unknown>>
  /** Capture submit POST args; the spy fills these in. */
  capturePost?: { url?: string; body?: unknown }
}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      // GET detail
      if (
        s.includes(`/api/clarify/${opts.session.intermediaryNodeRunId}`) &&
        !s.endsWith('/answers')
      ) {
        return new Response(JSON.stringify(opts.session), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // GET peers list
      if (s.includes('/api/clarify?')) {
        return new Response(JSON.stringify(opts.peers ?? []), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // GET task name (for the breadcrumb)
      if (s.includes(`/api/tasks/${opts.session.taskId}`)) {
        return new Response(JSON.stringify({ name: 'fixture-task' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // POST answers
      if (s.endsWith('/answers')) {
        if (opts.capturePost && init?.body) {
          opts.capturePost.url = s
          try {
            opts.capturePost.body = JSON.parse(String(init.body))
          } catch {
            /* ignore */
          }
        }
        return new Response(
          JSON.stringify({
            ok: true,
            kind: 'cross',
            outcome: { kind: 'questioner-stop-triggered', questionerNodeRunId: 'nr_q_new' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), {
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

describe('RFC-056 /clarify/$nodeRunId — cross-clarify branch', () => {
  test('cross-clarify renders the unified stop button (shared with self-clarify)', async () => {
    mockApi({ session: crossSession() })
    renderRoute('/clarify/nr_cross_1')
    await waitFor(() => screen.getByTestId('clarify-submit-stop'))
    // The old kind-specific testid is gone after the 2026-05-26 unification.
    expect(screen.queryByTestId('cross-clarify-reject')).toBeNull()
    const stop = screen.getByTestId('clarify-submit-stop')
    expect(stop.className).toContain('btn--ghost')
    expect(stop.getAttribute('data-directive')).toBe('stop')
  })

  test('clicking stop opens the confirm modal; Cancel closes it without submitting', async () => {
    const captured: { url?: string; body?: unknown } = {}
    mockApi({ session: crossSession(), capturePost: captured })
    renderRoute('/clarify/nr_cross_1')
    await waitFor(() => screen.getByTestId('clarify-submit-stop'))
    fireEvent.click(screen.getByTestId('clarify-submit-stop'))
    await waitFor(() => screen.getByTestId('clarify-stop-modal'))
    fireEvent.click(screen.getByTestId('clarify-stop-cancel'))
    await waitFor(() => {
      expect(screen.queryByTestId('clarify-stop-modal')).toBeNull()
    })
    expect(captured.body).toBeUndefined()
  })

  test('Confirm in the stop modal POSTs with directive="stop"', async () => {
    const captured: { url?: string; body?: unknown } = {}
    mockApi({ session: crossSession(), capturePost: captured })
    renderRoute('/clarify/nr_cross_1')
    await waitFor(() => screen.getByTestId('clarify-submit-stop'))
    fireEvent.click(screen.getByTestId('clarify-submit-stop'))
    await waitFor(() => screen.getByTestId('clarify-stop-confirm'))
    await act(async () => {
      fireEvent.click(screen.getByTestId('clarify-stop-confirm'))
    })
    await waitFor(() => {
      expect(captured.body).toBeDefined()
    })
    const body = captured.body as { directive?: string; ifMatchIteration?: number }
    expect(body.directive).toBe('stop')
    expect(body.ifMatchIteration).toBe(0)
  })

  test('cross-clarify context card surfaces the target designer', async () => {
    mockApi({ session: crossSession({ targetDesignerNodeId: 'designerABC' }) })
    renderRoute('/clarify/nr_cross_1')
    await waitFor(() => screen.getByTestId('cross-clarify-target-designer'))
    expect(screen.getByTestId('cross-clarify-target-designer').textContent ?? '').toContain(
      'designerABC',
    )
  })

  test('detail page is tagged with data-kind="cross" on the root container', async () => {
    mockApi({ session: crossSession() })
    renderRoute('/clarify/nr_cross_1')
    const root = await waitFor(() => screen.getByTestId('clarify-detail-page'))
    expect(root.getAttribute('data-kind')).toBe('cross')
  })

  test('abandoned cross-clarify session renders the abandoned chip', async () => {
    mockApi({ session: crossSession({ status: 'abandoned', directive: 'continue' }) })
    renderRoute('/clarify/nr_cross_1')
    await waitFor(() => screen.getByTestId('cross-clarify-abandoned-chip'))
  })
})

describe('RFC-056 detail source-code grep guards', () => {
  test('clarify.detail.tsx references the unified stop testids + cross-specific modal copy', () => {
    const src = readFileSync(DETAIL_TSX, 'utf-8')
    // Cross-specific modal copy is still consulted by the unified dialog
    // when the session is cross-clarify (kept so the cross-loop persistence
    // warning text is not silently dropped).
    expect(src).toContain('crossClarify.rejectModal.title')
    expect(src).toContain('crossClarify.rejectModal.body')
    expect(src).toContain('crossClarify.rejectModal.confirm')
    expect(src).toContain('crossClarify.multiSourceBanner')
    // Unified stop-modal testids shared by self- and cross-clarify.
    expect(src).toContain('clarify-submit-stop')
    expect(src).toContain('clarify-stop-modal')
    expect(src).toContain('clarify-stop-cancel')
    expect(src).toContain('clarify-stop-confirm')
    expect(src).toContain('cross-clarify-multi-source-banner')
  })
})
