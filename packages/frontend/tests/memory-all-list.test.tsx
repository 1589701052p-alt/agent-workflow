// MemoryAllList contract — locks the post-RFC-041 bug-fix:
//   1. The Approved / Archived filter drives the GET status= param.
//   2. Archive button confirms via window.confirm; rejecting it MUST NOT
//      fire POST /archive (the original bug — a single click could
//      silently archive a memory with no UI to recover it).
//   3. In Archived view, the row's primary action is Unarchive and
//      POSTs /unarchive — this is the only place in the UI today where
//      an archived memory can be restored.
//   4. Non-admin sees the action buttons disabled in both views.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MemorySummary } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { MemoryAllList } from '../src/components/memory/MemoryAllList'
import '../src/i18n'

function mkMem(overrides: Partial<MemorySummary> = {}): MemorySummary {
  return {
    id: 'mem_1',
    scopeType: 'global',
    scopeId: null,
    title: 'Prefer Option A',
    status: 'approved',
    tags: [],
    approvedAt: 1700000000000,
    version: 1,
    distillAction: null,
    ...overrides,
  }
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

function wrap(isAdmin: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryAllList isAdmin={isAdmin} />
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

describe('MemoryAllList — Approved/Archived filter + safe Archive', () => {
  test('default view is Approved → GET ?status=approved', async () => {
    const calls = installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkMem()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap(true)
    await waitFor(() => {
      expect(screen.getByTestId('memory-all-mem_1-archive')).toBeTruthy()
    })
    const get = calls.find((c) => c.method === 'GET')
    expect(get?.url).toContain('status=approved')
  })

  test('switching to Archived re-queries with ?status=archived and shows Unarchive', async () => {
    let lastStatusParam: string | null = null
    installFetch(({ url }) => {
      const u = new URL(url)
      const status = u.searchParams.get('status')
      lastStatusParam = status
      if (status === 'archived') {
        return new Response(
          JSON.stringify({ items: [mkMem({ id: 'mem_arc', status: 'archived' })] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ items: [mkMem()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap(true)
    await screen.findByTestId('memory-all-mem_1-archive')
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    await screen.findByTestId('memory-all-mem_arc-unarchive')
    expect(lastStatusParam).toBe('archived')
    // The Archive button must NOT render in archived view for this row.
    expect(screen.queryByTestId('memory-all-mem_arc-archive')).toBeNull()
  })

  test('Archive click without confirm DOES NOT POST /archive', async () => {
    const calls = installFetch(
      () =>
        new Response(JSON.stringify({ items: [mkMem()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    wrap(true)
    const btn = await screen.findByTestId('memory-all-mem_1-archive')
    fireEvent.click(btn)
    expect(confirmSpy).toHaveBeenCalledOnce()
    // Give react-query a tick to definitely not fire anything async.
    await new Promise((r) => setTimeout(r, 0))
    expect(calls.find((c) => c.method === 'POST')).toBeUndefined()
  })

  test('Archive click WITH confirm POSTs /archive', async () => {
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkMem()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkMem({ status: 'archived' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    wrap(true)
    const btn = await screen.findByTestId('memory-all-mem_1-archive')
    fireEvent.click(btn)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.url).toContain('/api/memories/mem_1/archive')
    })
  })

  test('Unarchive click POSTs /unarchive (no confirm required)', async () => {
    const calls = installFetch(({ method, url }) => {
      if (method === 'GET') {
        const u = new URL(url)
        if (u.searchParams.get('status') === 'archived') {
          return new Response(
            JSON.stringify({ items: [mkMem({ id: 'mem_arc', status: 'archived' })] }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(JSON.stringify({ memory: mkMem({ status: 'approved' }) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    const confirmSpy = vi.spyOn(window, 'confirm')
    wrap(true)
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    const btn = await screen.findByTestId('memory-all-mem_arc-unarchive')
    fireEvent.click(btn)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.url).toContain('/api/memories/mem_arc/unarchive')
    })
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  test('non-admin sees archive + unarchive disabled across views', async () => {
    installFetch(({ url }) => {
      const u = new URL(url)
      if (u.searchParams.get('status') === 'archived') {
        return new Response(
          JSON.stringify({ items: [mkMem({ id: 'mem_arc', status: 'archived' })] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({ items: [mkMem()] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    wrap(false)
    const archiveBtn = (await screen.findByTestId('memory-all-mem_1-archive')) as HTMLButtonElement
    expect(archiveBtn.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('memory-all-filter-archived'))
    const unarchiveBtn = (await screen.findByTestId(
      'memory-all-mem_arc-unarchive',
    )) as HTMLButtonElement
    expect(unarchiveBtn.disabled).toBe(true)
  })
})
