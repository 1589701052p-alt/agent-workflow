// RFC-111 PR-B (frontend) — Claude Code as a second agent runtime.
//
// Locks the user-facing wiring of the new runtime so a future refactor that
// re-points the model namespace / runtime selector goes red:
//
//  1. <ModelSelect> default (opencode) hits `/api/runtime/models` with NO
//     `?runtime=` param — byte-identical to the pre-RFC-111 behavior.
//  2. <ModelSelect runtime="claude"> hits `/api/runtime/models?runtime=claude`
//     (separate query namespace → curated static Claude list).
//  3. <AgentForm> renders the Runtime <Select> (public combobox chrome, not a
//     raw <select>) defaulting to "inherit", and selecting "Claude Code"
//     surfaces runtime: 'claude-code' upward.
//  4. When the effective runtime is claude-code the model field switches to the
//     claude namespace (`?runtime=claude`) and variant + temperature are
//     disabled (opencode-only — Claude Code's CLI has no equivalent).
//  5. The Runtime selector is gated: hidden when config.claudeCodeEnabled is
//     explicitly false (and the agent doesn't already pin a runtime).

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { CreateAgent } from '@agent-workflow/shared'
import { AgentForm, emptyAgent } from '../src/components/AgentForm'
import { ModelSelect } from '../src/components/ModelSelect'
import { setBaseUrl, setToken } from '../src/stores/auth'

let fetchUrls: string[] = []
// Each test may override what `/api/config` returns (drives the gating).
let configResponse: unknown = { claudeCodeEnabled: true }

const MODELS_BODY = {
  binary: 'claude',
  models: [{ id: 'opus', provider: 'anthropic', modelID: 'opus', name: 'Opus' }],
  cached: true,
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function newClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  })
}

function wrap(node: React.ReactNode) {
  return render(<QueryClientProvider client={newClient()}>{node}</QueryClientProvider>)
}

// Public Select = button[role=combobox] + portaled ul[role=listbox]; option rows
// fire onChange via mouseDown (fireEvent.click misses the React handler).
function clickSelectOption(triggerName: RegExp, optionLabel: string) {
  const trigger = screen.getByRole('combobox', { name: triggerName }) as HTMLButtonElement
  fireEvent.click(trigger)
  const list = document.querySelector('ul[role="listbox"]') as HTMLUListElement | null
  if (list === null) throw new Error('listbox not opened')
  const opt = Array.from(list.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(optionLabel),
  )
  if (opt === undefined) throw new Error(`option '${optionLabel}' not found`)
  fireEvent.mouseDown(opt)
}

// The variant / temperature inputs live inside a <label class="form-field">; the
// label span text is exactly the field label (the hint is a sibling span), so we
// can reach the input deterministically without a testid.
function inputUnderLabel(labelText: string): HTMLInputElement {
  const span = screen.getByText(labelText, { selector: '.form-field__label' })
  const input = span.closest('label')?.querySelector('input') ?? null
  if (input === null) throw new Error(`no input under label '${labelText}'`)
  return input as HTMLInputElement
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  fetchUrls = []
  configResponse = { claudeCodeEnabled: true }
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL | Request).toString()
    fetchUrls.push(url)
    if (url.includes('/api/runtime/models')) return jsonResponse(MODELS_BODY)
    if (url.includes('/api/config')) return jsonResponse(configResponse)
    return jsonResponse([])
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('ModelSelect — runtime namespace (RFC-111)', () => {
  test('default (opencode) hits /api/runtime/models with no ?runtime param', async () => {
    wrap(<ModelSelect value={undefined} onChange={() => {}} />)
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models'))).toBe(true)
    })
    const modelUrls = fetchUrls.filter((u) => u.includes('/api/runtime/models'))
    expect(modelUrls.every((u) => !u.includes('runtime=claude'))).toBe(true)
  })

  test('runtime="claude" hits /api/runtime/models?runtime=claude', async () => {
    wrap(<ModelSelect runtime="claude" value={undefined} onChange={() => {}} />)
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models?runtime=claude'))).toBe(true)
    })
  })
})

describe('AgentForm — runtime selector (RFC-111)', () => {
  test('renders a Runtime combobox defaulting to "inherit"', () => {
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    const trigger = screen.getByRole('combobox', { name: /^Runtime$/ })
    expect(trigger).toBeTruthy()
    expect(trigger.textContent).toMatch(/Inherit/)
  })

  test('selecting "Claude Code" surfaces runtime: claude-code on onChange', () => {
    const onChange = vi.fn<(next: CreateAgent) => void>()
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={onChange} />)

    clickSelectOption(/^Runtime$/, 'Claude Code')

    expect(onChange).toHaveBeenCalledTimes(1)
    const next = onChange.mock.calls[0]?.[0] as CreateAgent
    expect(next.runtime).toBe('claude-code')
  })

  test('claude-code agent: model uses claude namespace + variant/temperature disabled', async () => {
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', runtime: 'claude-code' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // Model field switched to the claude namespace.
    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models?runtime=claude'))).toBe(true)
    })

    // variant + temperature are opencode-only → disabled with an explanatory hint.
    expect(inputUnderLabel('Variant').disabled).toBe(true)
    expect(inputUnderLabel('Temperature').disabled).toBe(true)
    expect(screen.getAllByText(/opencode-only/).length).toBeGreaterThanOrEqual(1)
  })

  test('opencode agent keeps the opencode model namespace + enabled variant/temperature', async () => {
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo', runtime: 'opencode' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    await waitFor(() => {
      expect(fetchUrls.some((u) => u.includes('/api/runtime/models'))).toBe(true)
    })
    const modelUrls = fetchUrls.filter((u) => u.includes('/api/runtime/models'))
    expect(modelUrls.every((u) => !u.includes('runtime=claude'))).toBe(true)
    expect(inputUnderLabel('Variant').disabled).toBe(false)
    expect(inputUnderLabel('Temperature').disabled).toBe(false)
  })

  test('Runtime selector hidden when config.claudeCodeEnabled === false', async () => {
    configResponse = { claudeCodeEnabled: false }
    const initial: CreateAgent = { ...emptyAgent(), name: 'demo' }
    wrap(<AgentForm value={initial} onChange={() => {}} />)

    // Selector is shown optimistically until config resolves, then hidden.
    await waitFor(() => {
      expect(screen.queryByRole('combobox', { name: /^Runtime$/ })).toBeNull()
    })
  })
})
