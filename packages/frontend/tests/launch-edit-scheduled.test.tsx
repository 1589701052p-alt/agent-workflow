// RFC-159 (edit-config) — the launch form doubles as the scheduled-task
// "edit task config" editor. With `?editScheduled=<id>` it loads the schedule,
// seeds every field from the stored launchPayload, and PUTs the rebuilt payload
// back to /api/scheduled-tasks/:id (instead of POSTing a new task). Without the
// param it stays the plain launcher (regression guard: still POSTs /api/tasks).
//
// Rendered in a mini-router (mirrors scheduled-run-now.test.tsx) with fetch +
// useActor stubbed. cleanup() in afterEach unmounts portals before the next test.
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

// Stub the actor so UserPicker renders (source !== 'daemon') and no /api/auth/me
// round-trip is needed. A real (non-daemon) session user.
vi.mock('../src/hooks/useActor', () => ({
  useActor: () => ({
    data: {
      user: { id: 'me', username: 'me', displayName: 'Me', role: 'user', status: 'active' },
      source: 'session',
      permissions: [],
      linkedIdentities: [],
      pats: [],
    },
  }),
  usePermission: () => false,
}))

interface FetchCall {
  url: string
  method: string
  body: unknown
}

const WORKFLOW = {
  id: 'wf-1',
  name: 'My WF',
  definition: {
    inputs: [{ key: 'topic', label: 'Topic', kind: 'text', required: false }],
    nodes: [],
  },
}

const REFS = {
  branches: ['main'],
  tags: [],
  recentCommits: [],
  currentBranch: 'main',
  defaultBranch: 'main',
  hasCommits: true,
}

const SCHEDULE = {
  id: 'sched-1',
  name: 'nightly audit',
  ownerUserId: 'me',
  launchPayload: {
    workflowId: 'wf-1',
    name: 'nightly',
    repoPath: '/r',
    baseBranch: 'main',
    inputs: { topic: 'seeded topic' },
    workingBranch: 'feature/x',
    autoCommitPush: true,
    collaboratorUserIds: ['bob'],
  },
  scheduleSpec: { kind: 'daily', at: '09:00', timezone: 'UTC' },
  enabled: true,
  nextRunAt: null,
  lastRunAt: null,
  lastStatus: null,
  lastError: null,
  lastTaskId: null,
  consecutiveFailures: 0,
  createdAt: 1,
  updatedAt: 1,
}

const BOB = { id: 'bob', username: 'bob', displayName: 'Bob', role: 'user', status: 'active' }

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function installFetch(opts: { recent?: unknown[] } = {}): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = undefined
      if (typeof init?.body === 'string') {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      // Order matters: match the most specific paths first.
      if (url.includes('/api/scheduled-tasks/sched-1') && method === 'PUT')
        return json({ ...SCHEDULE, updatedAt: 2 })
      if (url.includes('/api/scheduled-tasks/sched-1')) return json(SCHEDULE)
      if (url.includes('/api/users/lookup')) return json([BOB])
      if (url.includes('/api/repos/refs')) return json(REFS)
      if (url.includes('/api/repos/recent')) return json(opts.recent ?? [])
      if (url.includes('/api/cached-repos')) return json({ items: [] })
      if (url.includes('/api/workflows/wf-1')) return json(WORKFLOW)
      if (url.includes('/api/tasks')) return json({ id: 'task-new' }, 201)
      return json({})
    },
  )
  return calls
}

async function renderLaunch(initialUrl: string) {
  const mod = await import('../src/routes/workflows.launch')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const launch = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/$id/launch',
    component: mod.LaunchRoute.options.component,
    validateSearch: mod.LaunchRoute.options.validateSearch,
  })
  const scheduledDetail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/scheduled/$id',
    component: () => <div data-testid="scheduled-detail-page" />,
  })
  const workflowEditor = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workflows/$id',
    component: () => <div data-testid="workflow-editor-page" />,
  })
  const taskPage = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => <div data-testid="task-page" />,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([launch, scheduledDetail, workflowEditor, taskPage]),
    history: createMemoryHistory({ initialEntries: [initialUrl] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

describe('RFC-159 — launch form edit-config mode (?editScheduled)', () => {
  test('pre-fills from launchPayload and PUTs the rebuilt config, then navigates', async () => {
    const calls = installFetch()
    await renderLaunch('/workflows/wf-1/launch?editScheduled=sched-1')

    // Field prefill from the stored launchPayload.
    expect(await screen.findByDisplayValue('nightly')).toBeTruthy() // task name
    expect(await screen.findByText('Bob')).toBeTruthy() // collaborator chip (id → UserPublic)
    expect(screen.getByDisplayValue('/r')).toBeTruthy() // repo path
    expect(screen.getByDisplayValue('seeded topic')).toBeTruthy() // workflow input
    expect(screen.getByDisplayValue('feature/x')).toBeTruthy() // working branch

    // Primary button is the edit label, not the launch label.
    const submit = screen.getByTestId('launch-submit')
    expect(submit.textContent).toBe('Save task config')

    fireEvent.click(submit)

    // PUTs the rebuilt launchPayload — NOT POST /api/tasks.
    await waitFor(() => {
      expect(
        calls.some((c) => c.method === 'PUT' && c.url.endsWith('/api/scheduled-tasks/sched-1')),
      ).toBe(true)
    })
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/tasks'))).toBe(false)

    const put = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/api/scheduled-tasks/sched-1'),
    )!
    const payload = (put.body as { launchPayload: Record<string, unknown> }).launchPayload
    expect(payload).toMatchObject({
      workflowId: 'wf-1',
      name: 'nightly',
      repoPath: '/r',
      baseBranch: 'main',
      inputs: { topic: 'seeded topic' },
      workingBranch: 'feature/x',
      autoCommitPush: true,
      collaboratorUserIds: ['bob'],
    })

    // Lands back on the schedule detail page.
    await waitFor(() => {
      expect(screen.getByTestId('scheduled-detail-page')).toBeTruthy()
    })
  })

  test('hides the "save as scheduled" button in edit mode', async () => {
    installFetch()
    await renderLaunch('/workflows/wf-1/launch?editScheduled=sched-1')
    await screen.findByDisplayValue('nightly')
    expect(screen.queryByTestId('save-as-scheduled')).toBeNull()
  })
})

describe('RFC-159 — launch form create mode (no editScheduled) is unchanged', () => {
  test('still POSTs /api/tasks and navigates to the new task', async () => {
    const calls = installFetch({ recent: [{ path: '/r', defaultBranch: 'main' }] })
    await renderLaunch('/workflows/wf-1/launch')

    // Recent-repo auto-pick fills the first row (create-mode behavior).
    expect(await screen.findByDisplayValue('/r')).toBeTruthy()

    // Primary button is the launch label; save-as-scheduled is present.
    const submit = screen.getByTestId('launch-submit')
    expect(submit.textContent).toBe('Start task')
    expect(screen.getByTestId('save-as-scheduled')).toBeTruthy()

    // Name is required — fill it, then Start enables.
    fireEvent.change(screen.getByTestId('launch-task-name'), { target: { value: 'My task' } })
    await waitFor(() => {
      expect((screen.getByTestId('launch-submit') as HTMLButtonElement).disabled).toBe(false)
    })

    fireEvent.click(screen.getByTestId('launch-submit'))

    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/tasks'))).toBe(true)
    })
    // Never touches the scheduled-tasks endpoint in create mode.
    expect(calls.some((c) => c.url.includes('/api/scheduled-tasks'))).toBe(false)

    await waitFor(() => {
      expect(screen.getByTestId('task-page')).toBeTruthy()
    })
  })
})
