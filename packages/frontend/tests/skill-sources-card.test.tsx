// RFC-017 — SkillSourcesCard: rendering, rescan POST, remove with blocker handling.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Skill, SkillSkipReport, SkillSourceWithStats } from '@agent-workflow/shared'
import { SkillSourcesCard, canReplaceConflict } from '../src/components/SkillSourcesCard'
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

// --- RFC-102: same-name conflict replace -----------------------------------

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function visibleSkill(name: string, ownerUserId: string | null): Skill {
  return {
    id: name,
    name,
    description: '',
    ownerUserId,
    visibility: 'public',
    sourceKind: 'managed',
    schemaVersion: 1,
    contentVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function meResponse(id: string, role: 'admin' | 'user') {
  return {
    user: { id, username: id, displayName: id, role, status: 'active' },
    source: 'session',
    permissions: [],
    linkedIdentities: [],
    pats: [],
  }
}

const conflictReport = (name: string): SkillSkipReport => ({
  childPath: `/x/${name}`,
  proposedName: name,
  reason: 'name-conflict-manual',
})

describe('canReplaceConflict (RFC-102)', () => {
  const rep = conflictReport('dup')
  const srcBy = (createdBy: string | null) => fakeSource(createdBy === null ? {} : { createdBy })

  test('non-conflict reasons are never replaceable (even for admin)', () => {
    expect(
      canReplaceConflict(
        { childPath: '', proposedName: 'dup', reason: 'no-skill-md' },
        srcBy('me'),
        [],
        'me',
        true,
      ),
    ).toBe(false)
  })
  test('admin can replace any conflict (non-registrar, non-owner)', () => {
    expect(canReplaceConflict(rep, srcBy('other'), [], 'admin', true)).toBe(true)
  })
  test('source registrar who owns the visible occupier can replace', () => {
    expect(canReplaceConflict(rep, srcBy('me'), [visibleSkill('dup', 'me')], 'me', false)).toBe(
      true,
    )
  })
  test('owns the occupier but is NOT the source registrar → cannot (would 403)', () => {
    expect(canReplaceConflict(rep, srcBy('other'), [visibleSkill('dup', 'me')], 'me', false)).toBe(
      false,
    )
  })
  test('source registrar but not owner of the occupier → cannot', () => {
    expect(canReplaceConflict(rep, srcBy('me'), [visibleSkill('dup', 'other')], 'me', false)).toBe(
      false,
    )
  })
  test('invisible occupier (absent from list) → cannot for non-admin', () => {
    expect(canReplaceConflict(rep, srcBy('me'), [], 'me', false)).toBe(false)
  })
  test('null current user → cannot', () => {
    expect(canReplaceConflict(rep, srcBy('me'), [visibleSkill('dup', 'me')], null, false)).toBe(
      false,
    )
  })
})

describe('SkillSourcesCard — RFC-102 conflict replace', () => {
  function mountWithConflict(occupierOwner: string | null, meRole: 'admin' | 'user' = 'user') {
    const source = fakeSource({ skipped: [conflictReport('dup')], createdBy: 'me' })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : (input as Request).url
      const method = (init?.method ?? 'GET').toUpperCase()
      if (method === 'GET' && url.endsWith('/api/skill-sources')) {
        return jsonRes({ sources: [source] })
      }
      if (method === 'GET' && url.endsWith('/api/skills')) {
        return jsonRes(occupierOwner === null ? [] : [visibleSkill('dup', occupierOwner)])
      }
      if (method === 'GET' && url.endsWith('/api/auth/me')) {
        return jsonRes(meResponse('me', meRole))
      }
      if (method === 'POST' && url.endsWith('/api/skill-sources/src1/conflicts/replace')) {
        return jsonRes({ source, replaced: 'dup', imported: visibleSkill('dup', 'me') })
      }
      return jsonRes({})
    })
    wrap(<SkillSourcesCard />)
    return fetchSpy
  }

  test('owned occupier → enabled Replace button POSTs to the replace endpoint', async () => {
    const fetchSpy = mountWithConflict('me')
    const btn = (await screen.findByTestId('source-conflict-replace-dup')) as HTMLButtonElement
    await waitFor(() => expect(btn.disabled).toBe(false))
    fireEvent.click(btn)
    await waitFor(() => {
      const calls = fetchSpy.mock.calls.map((c) =>
        typeof c[0] === 'string' ? c[0] : (c[0] as Request).url,
      )
      expect(calls.some((u) => u.endsWith('/api/skill-sources/src1/conflicts/replace'))).toBe(true)
    })
  })

  test('occupier owned by someone else → Replace is disabled', async () => {
    mountWithConflict('other')
    const btn = (await screen.findByTestId('source-conflict-replace-dup')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })

  test('invisible occupier (absent from /api/skills) → Replace disabled for non-admin', async () => {
    mountWithConflict(null)
    const btn = (await screen.findByTestId('source-conflict-replace-dup')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
  })
})
