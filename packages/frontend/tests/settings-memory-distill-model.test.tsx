// RFC-041 T5.3 — MemoryTab exposes `memoryDistillModel` next to the existing
// `memoryDistillLang` select so the distiller agent's model is configurable
// from the UI instead of needing manual config.json edits. Locks:
//   1. The tab renders a model input reflecting config.memoryDistillModel.
//   2. Editing the model and saving PATCHes /api/config with the new value.
//   3. Clearing the model saves with undefined → backend lands NULL.
//   4. i18n keys for memoryDistillModel label / hint exist in both locales.
//
// We force ModelSelect into its text-input fallback (mock the runtime models
// endpoint to 502) so the test stays decoupled from the provider list shape;
// the failed-fallback branch is already covered by model-select.test.tsx, and
// here we only care that the value round-trips through MemoryTab's PUT body.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Config } from '@agent-workflow/shared'
import { MemoryTab } from '../src/routes/settings'
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

function mockFetch() {
  const calls: Array<{ method: string; url: string; body: unknown }> = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (url: RequestInfo | URL, init?: RequestInit) => {
      const s = typeof url === 'string' ? url : url.toString()
      const method = init?.method ?? 'GET'
      // Force ModelSelect into its TextInput fallback so we can read/write the
      // model value via getByDisplayValue without depending on the dropdown
      // list shape.
      if (s.includes('/api/runtime/models')) {
        return new Response(JSON.stringify({ ok: false, code: 'opencode-models-failed' }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (s.includes('/api/config') && method === 'PUT') {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ method, url: s, body })
        return new Response(JSON.stringify(mkConfig({ ...body })), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  )
  return calls
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  void i18n.changeLanguage('zh-CN')
})

afterEach(() => {
  document.body.innerHTML = ''
  clearToken()
  vi.restoreAllMocks()
})

describe('RFC-041 T5.3 MemoryTab — distill model field', () => {
  test('reflects config.memoryDistillModel in the model input', async () => {
    mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryTab config={mkConfig({ memoryDistillModel: 'anthropic/sonnet-4-6' })} />, {
      wrapper: wrap(qc),
    })
    await waitFor(() => screen.getByDisplayValue('anthropic/sonnet-4-6'))
  })

  test('editing model and saving PATCHes /api/config with the new value', async () => {
    const calls = mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryTab config={mkConfig()} />, { wrapper: wrap(qc) })
    const input = (await waitFor(() => {
      const el = document.querySelector('input[type="text"]') as HTMLInputElement | null
      if (!el) throw new Error('model input not rendered yet')
      return el
    })) as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'openai/gpt-5' } })
    })
    expect(input.value).toBe('openai/gpt-5')
    const saveBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent && /保存|Save/.test(b.textContent))
    expect(saveBtn).toBeTruthy()
    act(() => {
      fireEvent.click(saveBtn!)
    })
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    const body = calls[0]?.body as { memoryDistillModel?: string }
    expect(body.memoryDistillModel).toBe('openai/gpt-5')
  })

  test('clearing the model saves with undefined → backend stores NULL', async () => {
    const calls = mockFetch()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<MemoryTab config={mkConfig({ memoryDistillModel: 'anthropic/sonnet-4-6' })} />, {
      wrapper: wrap(qc),
    })
    const input = (await waitFor(() =>
      screen.getByDisplayValue('anthropic/sonnet-4-6'),
    )) as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: '' } })
    })
    expect(input.value).toBe('')
    const saveBtn = screen
      .getAllByRole('button')
      .find((b) => b.textContent && /保存|Save/.test(b.textContent))
    act(() => {
      fireEvent.click(saveBtn!)
    })
    await waitFor(() => {
      expect(calls).toHaveLength(1)
    })
    const body = calls[0]?.body as Record<string, unknown>
    if ('memoryDistillModel' in body) {
      expect(body.memoryDistillModel).toBeNull()
    } else {
      expect(body.memoryDistillModel).toBeUndefined()
    }
  })

  test('i18n keys for memoryDistillModel label / hint reachable in both locales', () => {
    void i18n.changeLanguage('zh-CN')
    expect(i18n.t('settings.memoryDistillModelLabel')).toBe('记忆提炼模型')
    expect(i18n.t('settings.memoryDistillModelHint')).toContain('opencode')
    void i18n.changeLanguage('en-US')
    expect(i18n.t('settings.memoryDistillModelLabel')).toBe('Memory distill model')
    expect(i18n.t('settings.memoryDistillModelHint')).toContain('opencode')
  })
})
