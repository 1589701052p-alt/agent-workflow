// RFC-041 PR4 — InboxDrawer "memory" tab.
//
// Locks:
// 1. Admin sees the "memory" tab in the inbox tab bar.
// 2. Non-admin does NOT see the memory tab (admin-only group).
// 3. Memory tab body lists pending candidates.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { InboxDrawer } from '../src/components/shell/InboxDrawer'
import '../src/i18n'

function mkSum(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_cand_1',
    scopeType: 'workflow',
    scopeId: 'wf_a',
    title: 'pending candidate alpha',
    status: 'candidate',
    tags: [],
    approvedAt: null,
    version: 1,
    distillAction: 'new',
    ...overrides,
  }
}

function installFetch(opts: { permissions: string[]; candidates: MemorySummary[] }) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/api/auth/me')) {
      return new Response(
        JSON.stringify({
          user: {
            id: 'u',
            username: 'u',
            displayName: 'u',
            role: 'admin',
            status: 'active',
          },
          source: 'session',
          permissions: opts.permissions,
          linkedIdentities: [],
          pats: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/api/memories?status=candidate')) {
      return new Response(JSON.stringify({ items: opts.candidates }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/api/reviews') || url.includes('/api/clarify')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  })
}

function renderDrawer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <InboxDrawer open onClose={() => {}} />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  // Reviews + clarify + memory routes so navigate() targets don't error.
  const r1 = createRoute({
    getParentRoute: () => rootRoute,
    path: '/reviews',
    component: () => null,
  })
  const r2 = createRoute({
    getParentRoute: () => rootRoute,
    path: '/clarify',
    component: () => null,
  })
  const r3 = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, r1, r2, r3]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(<RouterProvider router={router as any} />)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  // Use testing-library cleanup to let React unmount the createPortal children
  // before we touch document.body.
  cleanup()
  vi.restoreAllMocks()
})

describe('InboxDrawer memory tab', () => {
  test('admin sees the memory tab', async () => {
    installFetch({ permissions: ['memory:approve'], candidates: [mkSum()] })
    renderDrawer()
    await waitFor(() => {
      expect(screen.getByTestId('inbox-tab-memory')).toBeTruthy()
    })
  })

  test('non-admin does not see the memory tab', async () => {
    installFetch({ permissions: ['memory:read'], candidates: [] })
    renderDrawer()
    await waitFor(() => {
      expect(screen.getByTestId('inbox-tab-all')).toBeTruthy()
    })
    expect(screen.queryByTestId('inbox-tab-memory')).toBeNull()
  })

  test('memory tab shows pending candidate rows', async () => {
    installFetch({
      permissions: ['memory:approve'],
      candidates: [
        mkSum({ id: 'mem_a', title: 'alpha title' }),
        mkSum({ id: 'mem_b', title: 'beta title' }),
      ],
    })
    renderDrawer()
    const tab = await screen.findByTestId('inbox-tab-memory')
    fireEvent.click(tab)
    await waitFor(() => {
      expect(screen.getByTestId('inbox-row-memory-mem_a')).toBeTruthy()
      expect(screen.getByTestId('inbox-row-memory-mem_b')).toBeTruthy()
    })
  })
})
