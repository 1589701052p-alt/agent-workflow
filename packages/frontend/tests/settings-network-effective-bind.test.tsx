// The Network settings tab echoes the daemon's EFFECTIVE binding (GET
// /api/daemon) into the editable bind fields the persisted config left unset —
// so the tab shows the address the daemon is really on (notably the concrete
// port when bindPort was blank / ephemeral) instead of an empty box. Regression
// guard for "why doesn't the Network tab reflect the current config": the
// effective port must backfill the *editable* (saveable) port field, must NOT
// overwrite a value the config already pins, and must leave the field blank when
// the daemon run-info is unavailable.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Config } from '@agent-workflow/shared'
import { NetworkTab } from '../src/routes/settings'
import i18n from '../src/i18n'
import { setBaseUrl, setToken, clearToken } from '../src/stores/auth'

function wrap(qc: QueryClient) {
  return function Wrapped({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  }
}

function mkConfig(overrides: Partial<Config> = {}): Config {
  return {
    $schema_version: 1,
    maxConcurrentNodes: 4,
    multiProcessSubprocessConcurrency: 4,
    defaultPerTaskMaxDurationMs: 3_600_000,
    defaultPerTaskMaxTotalTokens: 0,
    defaultPerNodeTimeoutMs: 1_800_000,
    worktreeAutoGc: { enabled: false },
    eventsArchiveThresholds: { perNodeRunRows: 50_000, globalRows: 1_000_000 },
    largeOutputThresholdBytes: 1_048_576,
    bindHost: '127.0.0.1',
    language: 'zh-CN',
    theme: 'system',
    logLevel: 'info',
    ...overrides,
  } as Config
}

// Mock GET /api/daemon; every other request resolves to an empty JSON object.
function mockDaemon(body: unknown | null) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      if (s.includes('/api/daemon') && method === 'GET') {
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    },
  )
}

function newQc() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

const DAEMON = {
  pid: 4321,
  host: '127.0.0.1',
  port: 52341,
  url: 'http://127.0.0.1:52341/',
  startedAt: '2026-07-08T00:00:00.000Z',
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  cleanup()
  clearToken()
  vi.restoreAllMocks()
})

describe('NetworkTab echoes the effective binding into the editable fields', () => {
  test('backfills the effective port into the editable bindPort field when config leaves it unset', async () => {
    mockDaemon(DAEMON)
    render(<NetworkTab config={mkConfig()} />, { wrapper: wrap(newQc()) })
    const port = (await screen.findByTestId('settings-bind-port')) as HTMLInputElement
    await waitFor(() => expect(port.value).toBe('52341'))
    // It is the real, editable field — not a read-only readout.
    expect(port.disabled).toBe(false)
    // The earlier separate read-only readout no longer exists.
    expect(screen.queryByTestId('settings-effective-bind')).toBeNull()
  })

  test('does NOT overwrite a port the config already pins', async () => {
    mockDaemon(DAEMON) // effective 52341
    render(<NetworkTab config={mkConfig({ bindPort: 8080 })} />, { wrapper: wrap(newQc()) })
    const port = (await screen.findByTestId('settings-bind-port')) as HTMLInputElement
    expect(port.value).toBe('8080')
    // Give the backfill effect a tick to (not) fire, then re-assert.
    await new Promise((r) => setTimeout(r, 30))
    expect(port.value).toBe('8080')
  })

  test('leaves the port field blank when the daemon run-info is unavailable (null)', async () => {
    mockDaemon(null)
    render(<NetworkTab config={mkConfig()} />, { wrapper: wrap(newQc()) })
    const port = (await screen.findByTestId('settings-bind-port')) as HTMLInputElement
    await new Promise((r) => setTimeout(r, 30))
    expect(port.value).toBe('')
  })
})
