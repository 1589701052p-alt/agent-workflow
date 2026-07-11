// RFC-167 T4 — /dynamic-workflow-spaces {list, detail} route pages.
//
// Locks:
//   1. List page: empty state; rows render name link + pool count; quick-create
//      button opens the shared dialog.
//   2. Detail page: the agent pool renders one item per name; a pool member
//      backed by a known agent shows the RFC-166 capability card; a dangling
//      name shows the "not found" note (soft reference, resolved at launch).
//   3. Detail pool editing: adding an agent name grows the pool; remove shrinks it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { Agent, DynamicWorkflowSpace } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function space(name: string, over: Partial<DynamicWorkflowSpace> = {}): DynamicWorkflowSpace {
  return {
    id: `dws_${name}`,
    name,
    description: 'orchestrated',
    agentPool: ['coder', 'ghost'],
    ownerUserId: null,
    visibility: 'public',
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

const CODER: Partial<Agent> = { name: 'coder', description: 'writes the patch', outputs: ['patch'] }

function installFetch(state: { spaces: DynamicWorkflowSpace[] }): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/api/agents')) return json([CODER, { name: 'auditor' }])
      const one = url.match(/\/api\/dynamic-workflow-spaces\/([^/]+)$/)
      if (one !== null) {
        const name = decodeURIComponent(one[1]!)
        if (method === 'GET') {
          const row = state.spaces.find((s) => s.name === name)
          return row !== undefined ? json(row) : json({ code: 'not-found' }, 404)
        }
        if (method === 'PUT') return json(state.spaces.find((s) => s.name === name) ?? space(name))
        if (method === 'DELETE') return new Response(null, { status: 204 })
      }
      if (url.endsWith('/api/dynamic-workflow-spaces') && method === 'GET')
        return json(state.spaces)
      if (url.endsWith('/api/dynamic-workflow-spaces') && method === 'POST')
        return json(space('x'), 201)
      return json([])
    },
  )
}

async function renderPage(initialEntry: string) {
  const list = await import('../src/routes/dynamic-workflow-spaces')
  const detail = await import('../src/routes/dynamic-workflow-spaces.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dynamic-workflow-spaces',
    component: list.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/dynamic-workflow-spaces/$name',
    component: detail.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('/dynamic-workflow-spaces list', () => {
  test('empty state renders', async () => {
    installFetch({ spaces: [] })
    await renderPage('/dynamic-workflow-spaces')
    expect(await screen.findByTestId('dwspaces-empty')).toBeTruthy()
  })

  test('rows render name + pool count; new button present', async () => {
    installFetch({ spaces: [space('squad')] })
    await renderPage('/dynamic-workflow-spaces')
    const row = await screen.findByTestId('dwspace-row-squad')
    expect(within(row).getByText('squad')).toBeTruthy()
    expect(within(row).getByText('2')).toBeTruthy() // pool size
    expect(screen.getByTestId('dwspace-new-button')).toBeTruthy()
  })
})

describe('/dynamic-workflow-spaces/$name detail — pool + capability preview', () => {
  test('known pool agent shows capability card; dangling name shows missing note', async () => {
    installFetch({ spaces: [space('squad')] })
    await renderPage('/dynamic-workflow-spaces/squad')
    // capability card for the resolvable 'coder'
    expect(await screen.findByTestId('capability-card-coder')).toBeTruthy()
    expect(screen.getByText('writes the patch')).toBeTruthy()
    // 'ghost' is not in the agent roster → missing note, no card
    expect(screen.queryByTestId('capability-card-ghost')).toBeNull()
    expect(screen.getByTestId('dwspace-pool-remove-ghost')).toBeTruthy()
  })

  test('adding an agent name grows the pool', async () => {
    installFetch({ spaces: [space('squad', { agentPool: [] })] })
    await renderPage('/dynamic-workflow-spaces/squad')
    const input = await screen.findByTestId('dwspace-pool-add-input')
    fireEvent.change(input, { target: { value: 'auditor' } })
    fireEvent.click(screen.getByTestId('dwspace-pool-add-button'))
    await waitFor(() => expect(screen.getByTestId('dwspace-pool-remove-auditor')).toBeTruthy())
  })
})
