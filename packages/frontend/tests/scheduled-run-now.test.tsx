// RFC-159 T7 — the "Run now" button on the scheduled-task detail route.
// Locks: the button renders, clicking it POSTs to /:id/run-now, and on success
// the page navigates to the freshly-launched task. We bypass the real router by
// rendering the page component in a mini-router (mirrors distill-job-detail-route)
// and stub fetch + the WS hook.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

vi.mock('../src/hooks/useScheduledTaskWs', () => ({ useScheduledTaskWs: () => undefined }))

interface FetchCall {
  url: string
  method: string
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup() // unmount React trees (incl. Dialog portals) before clearing the DOM
  vi.restoreAllMocks()
})

const SCHEDULE = {
  id: 'sched-1',
  name: 'nightly audit',
  ownerUserId: 'bob',
  launchPayload: { workflowId: 'wf', name: 'nightly', repoPath: '/r', baseBranch: 'main' },
  scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
  enabled: true,
  nextRunAt: Date.now() + 1000,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

function installFetch(): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      calls.push({ url, method })
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      if (url.includes('/run-now')) return json({ taskId: 'task-xyz' }, 201)
      if (url.includes('/api/tasks')) return json([]) // run history
      if (url.includes('/api/scheduled-tasks/sched-1')) return json(SCHEDULE)
      return json({})
    },
  )
  return calls
}

async function renderDetail() {
  const mod = await import('../src/routes/scheduled.$id')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const detail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled/$id',
    component: mod.Route.options.component,
  })
  // Stub target so navigate({ to: '/tasks/$id' }) resolves to something renderable.
  const taskPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-page" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([detail, taskPage]),
    history: createMemoryHistory({ initialEntries: ['/scheduled/sched-1'] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('RFC-159 T7 — Run now button', () => {
  test('renders, POSTs to /run-now, and navigates to the launched task', async () => {
    const calls = installFetch()
    await renderDetail()

    const btn = await screen.findByTestId('scheduled-run-now')
    expect(btn.textContent).toBe('Run now')

    fireEvent.click(btn)

    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === 'POST' && c.url.endsWith('/api/scheduled-tasks/sched-1/run-now'),
        ),
      ).toBe(true)
    })
    // On success it navigates to the new task page.
    await waitFor(() => {
      expect(screen.getByTestId('task-page')).toBeTruthy()
    })
  })

  // RFC-159 — edit entry (user feedback 2026-07-10): the detail page must expose an
  // editor for the trigger period, pre-filled with the schedule's current values.
  test('Edit opens the schedule dialog pre-filled with the current schedule', async () => {
    installFetch()
    await renderDetail()

    fireEvent.click(await screen.findByTestId('scheduled-edit'))

    await waitFor(() => {
      expect(screen.getByTestId('schedule-dialog')).toBeTruthy()
    })
    expect((screen.getByTestId('schedule-name') as HTMLInputElement).value).toBe('nightly audit')
  })
})
