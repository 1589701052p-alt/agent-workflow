// RFC-041 PR4 — top-level Memory nav link.
//
// Locks:
// 1. Link is rendered with the data-testid="nav-memory-link".
// 2. Admin (has memory:approve) AND there exist candidates → badge shown.
// 3. Non-admin → no badge even if /api/memories returns candidates (query
//    is gated by usePermission and disabled, so no fetch fires).

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
import { render, screen, waitFor } from '@testing-library/react'
import type { Memory, MemorySummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryNavLink } from '../src/components/shell/MemoryNavLink'
import '../src/i18n'

function mkSum(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_cand_1',
    scopeType: 'workflow',
    scopeId: 'wf_a',
    title: 'X',
    status: 'candidate',
    tags: [],
    approvedAt: null,
    version: 1,
    distillAction: 'new',
    ...overrides,
  }
}

interface FetchedUrls {
  list: string[]
}

function installFetch(
  meResponse: { permissions: string[] },
  candidates: Memory[] | MemorySummary[],
): FetchedUrls {
  const list: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    list.push(url)
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
          permissions: meResponse.permissions,
          linkedIdentities: [],
          pats: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    if (url.includes('/api/memories')) {
      return new Response(JSON.stringify({ items: candidates }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response('{}', { status: 200 })
  })
  return { list }
}

function renderInRouter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <MemoryNavLink />
        <Outlet />
      </QueryClientProvider>
    ),
  })
  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => null,
  })
  // /memory route doesn't need a real component for this nav-only test.
  const memoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([homeRoute, memoryRoute]),
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
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('MemoryNavLink', () => {
  test('link is always rendered for logged-in user', async () => {
    installFetch({ permissions: ['memory:read'] }, [])
    renderInRouter()
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-link')).toBeTruthy()
    })
  })

  test('admin with pending candidates sees the badge', async () => {
    installFetch({ permissions: ['memory:read', 'memory:approve'] }, [mkSum(), mkSum({ id: 'm2' })])
    renderInRouter()
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-badge').textContent).toBe('2')
    })
  })

  test('non-admin never shows the badge', async () => {
    installFetch({ permissions: ['memory:read'] }, [mkSum(), mkSum({ id: 'm2' })])
    renderInRouter()
    // Wait for actor to load + the nav link render — give the badge time to appear.
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-link')).toBeTruthy()
    })
    // Badge should be absent.
    expect(screen.queryByTestId('nav-memory-badge')).toBeNull()
  })
})
