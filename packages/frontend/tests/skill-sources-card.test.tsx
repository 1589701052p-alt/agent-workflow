// RFC-017 — SkillSourcesCard: rendering, rescan POST, remove with blocker handling.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SkillSourceWithStats } from '@agent-workflow/shared'
import { SkillSourcesCard } from '../src/components/SkillSourcesCard'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function fakeSource(over: Partial<SkillSourceWithStats> = {}): SkillSourceWithStats {
  return {
    id: 'src1',
    path: '/Users/me/.claude/skills',
    label: 'Claude skills',
    enabled: true,
    lastScannedAt: 1_700_000_000_000,
    lastScanError: null,
    createdAt: 0,
    updatedAt: 0,
    childCount: 3,
    skipped: [],
    ...over,
  }
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

// useMutation rejections bubble as unhandledrejection in jsdom even though
// the UI handled the error via `mutation.error`. Swallow them so the suite
// stays green.
function silenceMutationRejection(e: PromiseRejectionEvent | Event) {
  if ('preventDefault' in e) e.preventDefault()
}
beforeEach(() => window.addEventListener('unhandledrejection', silenceMutationRejection))
afterEach(() => window.removeEventListener('unhandledrejection', silenceMutationRejection))

describe('SkillSourcesCard', () => {
  test('renders empty state when no sources are registered', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ sources: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(<SkillSourcesCard />)
    await waitFor(() => expect(screen.getByText(/no skill folders/i)).toBeTruthy())
  })

  test('renders a card per source with label / path / childCount', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          sources: [
            fakeSource({ id: 'a', label: 'Alpha', path: '/a' }),
            fakeSource({ id: 'b', label: 'Beta', path: '/b', childCount: 12 }),
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    )
    wrap(<SkillSourcesCard />)
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy())
    expect(screen.getByText('Beta')).toBeTruthy()
    expect(screen.getByText('/a')).toBeTruthy()
    expect(screen.getByText('/b')).toBeTruthy()
    expect(screen.getByText(/12/)).toBeTruthy()
  })

  test('Rescan button POSTs to /api/skill-sources/:id/rescan', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      if (url.endsWith('/api/skill-sources')) {
        return new Response(JSON.stringify({ sources: [fakeSource()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // The rescan POST.
      return new Response(
        JSON.stringify({
          source: { ...fakeSource(), childCount: 4 },
          imported: [],
          deleted: [],
          skipped: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })

    wrap(<SkillSourcesCard />)
    await waitFor(() => expect(screen.getByText(/Claude skills/)).toBeTruthy())
    const btn = screen.getByRole('button', { name: /rescan/i })
    fireEvent.click(btn)
    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) =>
        typeof c[0] === 'string' ? c[0] : (c[0] as Request).url,
      )
      expect(calls.some((u) => u.endsWith('/api/skill-sources/src1/rescan'))).toBe(true)
    })
  })

  test('Remove with skill-source-children-referenced surfaces blocker list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url.endsWith('/api/skill-sources')) {
        return new Response(JSON.stringify({ sources: [fakeSource()] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      if (method === 'DELETE') {
        return new Response(
          JSON.stringify({
            error: {
              code: 'skill-source-children-referenced',
              message: '1 child still referenced',
              details: { blockers: [{ skillName: 'pinned', byAgent: 'agent-a' }] },
            },
          }),
          { status: 422, headers: { 'content-type': 'application/json' } },
        )
      }
      return new Response('{}', { status: 200 })
    })

    const { container } = wrap(<SkillSourcesCard />)
    await waitFor(() => expect(screen.getByText(/Claude skills/)).toBeTruthy())
    // ConfirmButton swaps its label between idle and "armed" states on the
    // same <button>; click it twice to trigger the actual DELETE.
    const findRemoveBtn = () => {
      const btns = Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]
      return btns.find((b) => /remove|删除|解除/i.test(b.textContent ?? ''))!
    }
    fireEvent.click(findRemoveBtn())
    fireEvent.click(findRemoveBtn())
    await waitFor(() => screen.getByRole('alert'))
    const alert = screen.getByRole('alert')
    expect(alert.textContent ?? '').toContain('pinned')
    expect(alert.textContent ?? '').toContain('agent-a')
  })
})
