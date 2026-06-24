// LOCKS: /users action column — self-disable lockout + re-enable affordance.
//
// Regression coverage for the 2026-06-24 incident (an admin disabled their own
// account and there was no UI path to restore it). Locks in:
//   - The current admin's OWN row shows NO "Disable" button (self-disable
//     lockout; the backend also enforces self-disable-forbidden).
//   - A disabled user shows an "Enable" button; clicking it PATCHes
//     {status:'active'} to /api/users/:id — the inverse of the DELETE disable,
//     so a disabled account is never stranded with no way back.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { UsersPage } from '../src/routes/users'
import i18n from '../src/i18n'

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ME = {
  user: { id: 'me-admin', username: 'root', displayName: 'Root', role: 'admin', status: 'active' },
  source: 'session',
  permissions: ['users:read', 'users:write'],
  linkedIdentities: [],
  pats: [],
}

const ROWS = [
  // The currently-logged-in admin (self).
  {
    id: 'me-admin',
    username: 'root',
    email: null,
    displayName: 'Root',
    role: 'admin',
    status: 'active',
    lastLoginAt: null,
  },
  // Another active user — disable-able.
  {
    id: 'u-alice',
    username: 'alice',
    email: null,
    displayName: 'Alice',
    role: 'user',
    status: 'active',
    lastLoginAt: null,
  },
  // A disabled user — should expose an Enable button.
  {
    id: 'u-dave',
    username: 'dave',
    email: null,
    displayName: 'Dave',
    role: 'user',
    status: 'disabled',
    lastLoginAt: null,
  },
]

function route(call: FetchCall): Response {
  if (call.url.includes('/api/auth/me')) return jsonResponse(ME)
  if (call.method === 'GET' && /\/api\/users(\?.*)?$/.test(call.url)) return jsonResponse(ROWS)
  if (call.method === 'PATCH' && /\/api\/users\/[^/?]+$/.test(call.url)) {
    return jsonResponse({
      id: 'u-dave',
      username: 'dave',
      email: null,
      displayName: 'Dave',
      role: 'user',
      status: 'active',
      lastLoginAt: null,
    })
  }
  return jsonResponse({ code: 'not-mocked', message: call.url }, 500)
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <UsersPage />
    </QueryClientProvider>,
  )
}

beforeEach(async () => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  await i18n.changeLanguage('en-US')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('/users action column', () => {
  test('own row hides Disable; only the other active user is disable-able', async () => {
    installFetch(route)
    renderPage()
    await screen.findByText('alice')
    // me-admin is self → hidden; dave is disabled → no Disable; only alice left.
    expect(screen.getAllByRole('button', { name: 'Disable' })).toHaveLength(1)
  })

  test('disabled user shows Enable → PATCH {status:active}', async () => {
    const calls = installFetch(route)
    renderPage()
    await screen.findByText('dave')
    const enableBtns = screen.getAllByRole('button', { name: 'Enable' })
    expect(enableBtns).toHaveLength(1)
    fireEvent.click(enableBtns[0]!)
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'PATCH' && /\/api\/users\/u-dave$/.test(c.url))).toBe(
        true,
      )
    })
    const patch = calls.find((c) => c.method === 'PATCH')!
    expect(patch.body).toEqual({ status: 'active' })
  })
})
