// RFC-112 PR-D (frontend) — the runtime registry list replaces the two stacked
// RFC-111 status cards. Locks: built-ins + custom forks render as rows; built-in
// rows are read-only (Test only, no Edit/Delete); custom rows add Edit/Delete; a
// conforming smoke result shows its status; "Add runtime" opens the form dialog
// (public Dialog chrome, not a raw modal).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RuntimeList } from '../src/components/RuntimeList'
import { setBaseUrl, setToken } from '../src/stores/auth'

const RUNTIMES_BODY = {
  runtimes: [
    {
      name: 'opencode',
      protocol: 'opencode',
      binaryPath: null,
      builtin: true,
      lastProbe: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      name: 'claude-code',
      protocol: 'claude-code',
      binaryPath: null,
      builtin: true,
      lastProbe: null,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      name: 'my-oc',
      protocol: 'opencode',
      binaryPath: '/usr/local/bin/my-oc',
      builtin: false,
      lastProbe: {
        outcome: 'conforms',
        conforms: true,
        detail: 'ok',
        sawNonce: true,
        sawEnvelope: false,
        exitCode: 0,
      },
      createdAt: 0,
      updatedAt: 0,
    },
  ],
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function wrap(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    if (url.includes('/api/runtimes')) return jsonResponse(RUNTIMES_BODY)
    return jsonResponse({})
  })
})

afterEach(() => {
  // cleanup() unmounts tracked React roots (incl. the Dialog portal) correctly;
  // manually wiping document.body would double-remove the portal node under
  // happy-dom + React 19 (removeChild DOMException).
  cleanup()
  vi.restoreAllMocks()
})

describe('RuntimeList (RFC-112 PR-D)', () => {
  test('renders built-ins + the custom fork as rows', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(document.querySelector('.runtime-list__name')).toBeTruthy())
    // row NAMES (scoped to .runtime-list__name so the protocol chips — which also
    // read "opencode" — don't collide).
    const names = Array.from(document.querySelectorAll('.runtime-list__name')).map(
      (el) => el.textContent,
    )
    expect(names).toEqual(['opencode', 'claude-code', 'my-oc'])
    // the custom row surfaces its conforming smoke status + its binary path.
    expect(screen.getByText('conforms')).toBeTruthy()
    expect(screen.getByText('/usr/local/bin/my-oc')).toBeTruthy()
  })

  test('built-in rows are read-only (Test only); the custom row adds Edit + Delete', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    // three rows → three Test buttons; only the custom row → one Edit + one Delete.
    expect(screen.getAllByRole('button', { name: /^Test$/ }).length).toBe(3)
    expect(screen.getAllByRole('button', { name: /^Edit$/ }).length).toBe(1)
    expect(screen.getAllByRole('button', { name: /^Delete$/ }).length).toBe(1)
  })

  test('"Add runtime" opens the form dialog with the public Dialog chrome', async () => {
    wrap(<RuntimeList />)
    await waitFor(() => expect(screen.getByText('my-oc')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /add runtime/i }))
    expect(screen.getByRole('dialog')).toBeTruthy()
    // the protocol picker is the public Select combobox, not a raw <select>.
    expect(screen.getByRole('combobox', { name: /protocol/i })).toBeTruthy()
  })
})
