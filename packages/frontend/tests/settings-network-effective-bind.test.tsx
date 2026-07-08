// The Network settings tab renders a read-only "current actual binding" readout
// sourced from GET /api/daemon, so the tab reflects the address the daemon is
// really listening on — not just the persisted (and possibly blank / ephemeral)
// bindHost/bindPort. Regression guard for "why doesn't the Network tab echo the
// current config": the effective bind must appear, be read-only, and gracefully
// disappear when the daemon run-info is unavailable.

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

describe('NetworkTab effective-bind readout', () => {
  test('shows the daemon effective host:port as a read-only field', async () => {
    mockDaemon({
      pid: 4321,
      host: '127.0.0.1',
      port: 52341,
      url: 'http://127.0.0.1:52341/',
      startedAt: '2026-07-08T00:00:00.000Z',
    })
    render(<NetworkTab config={mkConfig()} />, { wrapper: wrap(newQc()) })
    const readout = (await screen.findByTestId('settings-effective-bind')) as HTMLInputElement
    expect(readout.value).toBe('127.0.0.1:52341')
    // Read-only: it must never be an editable field.
    expect(readout.disabled).toBe(true)
  })

  test('hides the readout when the daemon run-info is unavailable (null)', async () => {
    mockDaemon(null)
    render(<NetworkTab config={mkConfig()} />, { wrapper: wrap(newQc()) })
    // The editable bindHost field always renders; wait for a paint, then assert
    // the effective-bind readout is absent rather than showing "null".
    await waitFor(() => {
      expect(screen.getByText(i18n.t('settingsForm.bindHost'))).toBeTruthy()
    })
    await new Promise((r) => setTimeout(r, 30))
    expect(screen.queryByTestId('settings-effective-bind')).toBeNull()
  })

  test('i18n keys for the readout label/hint resolve in both locales', () => {
    void i18n.changeLanguage('zh-CN')
    expect(i18n.t('settingsForm.effectiveBindLabel')).toBe('当前实际监听')
    expect(i18n.t('settingsForm.effectiveBindHint')).not.toBe('settingsForm.effectiveBindHint')
    void i18n.changeLanguage('en-US')
    expect(i18n.t('settingsForm.effectiveBindLabel')).toBe('Currently listening on')
    expect(i18n.t('settingsForm.effectiveBindHint')).not.toBe('settingsForm.effectiveBindHint')
  })
})
