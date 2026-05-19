// RFC-041 PR4 — Memory group in the sidebar nav.
//
// Locks:
// 1. NAV_GROUPS exposes a "memory" group with a single /memory sub-item.
// 2. <MemoryPendingBadge /> hides when actor lacks memory:approve (no badge,
//    no fetch fired beyond /api/auth/me).
// 3. Admin with ≥1 candidate sees a numeric badge.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryPendingBadge } from '../src/components/shell/MemoryPendingBadge'
import { NAV_GROUPS } from '../src/lib/nav'
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

function installFetch(
  meResponse: { permissions: string[] },
  candidates: MemorySummary[],
): { urls: string[] } {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString()
    urls.push(url)
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
  return { urls }
}

function renderBadge() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryPendingBadge />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('NAV_GROUPS includes memory', () => {
  test('memory group has a single /memory sub-item', () => {
    const memory = NAV_GROUPS.find((g) => g.key === 'memory')
    expect(memory).toBeTruthy()
    expect(memory!.i18nKey).toBe('nav.group.memory')
    expect(memory!.subnav).toHaveLength(1)
    expect(memory!.subnav[0]?.to).toBe('/memory')
    expect(memory!.subnav[0]?.i18nKey).toBe('nav.memory')
  })
})

describe('MemoryPendingBadge', () => {
  test('admin with pending candidates renders the badge', async () => {
    installFetch({ permissions: ['memory:read', 'memory:approve'] }, [mkSum(), mkSum({ id: 'm2' })])
    renderBadge()
    await waitFor(() => {
      expect(screen.getByTestId('nav-memory-badge').textContent).toBe('2')
    })
  })

  test('non-admin sees no badge (and no /api/memories fetch fires)', async () => {
    const { urls } = installFetch({ permissions: ['memory:read'] }, [mkSum(), mkSum({ id: 'm2' })])
    renderBadge()
    // Allow react-query a tick to consider firing the candidate query.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('nav-memory-badge')).toBeNull()
    expect(urls.some((u) => u.includes('/api/memories'))).toBe(false)
  })

  test('admin with zero pending candidates does not render the badge', async () => {
    installFetch({ permissions: ['memory:approve'] }, [])
    renderBadge()
    // Wait long enough for the actor + candidate fetches to settle.
    await new Promise((r) => setTimeout(r, 20))
    expect(screen.queryByTestId('nav-memory-badge')).toBeNull()
  })
})
