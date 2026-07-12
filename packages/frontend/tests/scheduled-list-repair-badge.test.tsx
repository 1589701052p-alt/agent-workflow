// LOCKS: RFC-165 T14 — the /scheduled list surfaces a repair badge on rows
// whose stored config needs attention (healer-disabled path payloads carry
// lastError; legacy/corrupt payloads read as migrationNeeded / null columns),
// pointing users at the wizard's editScheduled repair path. Healthy rows show
// no badge.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { setBaseUrl, setToken } from '../src/stores/auth'
import '../src/i18n'

const HEALTHY = {
  id: 'sched-ok',
  name: 'healthy nightly',
  ownerUserId: 'me',
  launchKind: 'workflow',
  launchPayload: { workflowId: 'wf-1', name: 'n', repoUrl: 'https://h/o/r.git', inputs: {} },
  scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  migrationNeeded: false,
  migrationError: null,
  createdAt: 1,
  updatedAt: 1,
}
const DEGRADED = {
  ...HEALTHY,
  id: 'sched-bad',
  name: 'legacy path row',
  launchPayload: null,
  migrationNeeded: true,
  migrationError: { launchPayload: 'legacy-shape: repoPath retired', scheduleSpec: null },
  lastError: 'rfc165-local-path-retired',
  enabled: false,
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

async function renderList() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
    const url = input.toString()
    const json = (payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    if (url.includes('/api/scheduled-tasks')) return json([HEALTHY, DEGRADED])
    return json({})
  })
  const mod = await import('../src/routes/scheduled')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const list = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled',
    component: mod.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([list]),
    history: createMemoryHistory({ initialEntries: ['/scheduled'] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('RFC-165 T14 — scheduled list repair badge', () => {
  test('degraded/disabled rows carry the badge; healthy rows do not', async () => {
    await renderList()
    expect(await screen.findByTestId('scheduled-repair-sched-bad')).toBeTruthy()
    await screen.findByTestId('scheduled-row-sched-ok')
    expect(screen.queryByTestId('scheduled-repair-sched-ok')).toBeNull()
  })
})
