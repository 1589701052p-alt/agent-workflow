// RFC-164 PR-1 — /workgroups {list,new,detail} route pages + wiring locks.
//
// Locks:
//   1. List page: empty state, row rendering (name link / mode chip / member
//      count / leader displayName with fc em dash), delete via the shared
//      <Dialog> confirm firing DELETE.
//   2. New page: live validation disables Create while invalid; a completed
//      draft POSTs the built payload and navigates to the detail route.
//   3. Detail page: seeds the form from GET, PUT strips the name, rename
//      dialog POSTs /rename.
//   4. Wiring: router registers new-before-$name, nav lists /workgroups in
//      the workflows group, zh-CN + en-US both carry the workgroups keys
//      (same style as mcps-page-wiring).

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'
import type { Workgroup } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { zhCN } from '../src/i18n/zh-CN'
import { enUS } from '../src/i18n/en-US'
import '../src/i18n'

const TEST_DIR = path.dirname(new URL(import.meta.url).pathname)
const FRONTEND_SRC = resolve(TEST_DIR, '..', 'src')

function readSrc(rel: string): string {
  return readFileSync(resolve(FRONTEND_SRC, rel), 'utf-8')
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function wg(name: string, overrides: Partial<Workgroup> = {}): Workgroup {
  return {
    id: `wg_${name}`,
    name,
    description: 'audits PRs',
    instructions: '',
    mode: 'leader_worker',
    leaderMemberId: 'mem_1',
    switches: { shareOutputs: true, directMessages: false, blackboard: false },
    maxRounds: 20,
    completionGate: false,
    members: [
      {
        id: 'mem_1',
        memberType: 'agent',
        agentName: 'coder',
        userId: null,
        displayName: 'Coder',
        roleDesc: 'writes code',
        sortOrder: 0,
      },
      {
        id: 'mem_2',
        memberType: 'human',
        agentName: null,
        userId: 'u1',
        displayName: 'Alice',
        roleDesc: 'reviews',
        sortOrder: 1,
      },
    ],
    ownerUserId: null,
    visibility: 'public',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1_720_000_000_000,
    ...overrides,
  }
}

interface Recorded {
  calls: Array<{ url: string; method: string; body: unknown }>
}

function installFetch(state: { workgroups: Workgroup[] } & Recorded): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      state.calls.push({ url, method, body })
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        })

      if (url.includes('/api/agents')) return json([{ name: 'coder' }, { name: 'auditor' }])
      if (url.includes('/api/users/search')) return json([])
      if (url.includes('/api/users/lookup')) return json([])
      const rename = url.match(/\/api\/workgroups\/([^/]+)\/rename$/)
      if (rename !== null && method === 'POST') {
        const from = decodeURIComponent(rename[1]!)
        const row = state.workgroups.find((w) => w.name === from)
        return json({ ...(row ?? wg(from)), name: (body as { newName: string }).newName })
      }
      const one = url.match(/\/api\/workgroups\/([^/]+)$/)
      if (one !== null) {
        const name = decodeURIComponent(one[1]!)
        if (method === 'GET') {
          const row = state.workgroups.find((w) => w.name === name)
          return row !== undefined ? json(row) : json({ code: 'workgroup-not-found' }, 404)
        }
        if (method === 'PUT') {
          const row = state.workgroups.find((w) => w.name === name)
          return json({
            ...(row ?? wg(name)),
            description: (body as { description: string }).description,
          })
        }
        if (method === 'DELETE') return new Response(null, { status: 204 })
      }
      if (url.endsWith('/api/workgroups') && method === 'GET') return json(state.workgroups)
      if (url.endsWith('/api/workgroups') && method === 'POST') {
        return json(wg((body as { name: string }).name), 201)
      }
      return json({})
    },
  )
}

async function renderPage(initialEntry: string) {
  const list = await import('../src/routes/workgroups')
  const create = await import('../src/routes/workgroups.new')
  const detail = await import('../src/routes/workgroups.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups',
    component: list.Route.options.component,
  })
  const newRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/new',
    component: create.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/$name',
    component: detail.Route.options.component,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([listRoute, newRoute, detailRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
  return router
}

describe('/workgroups list page', () => {
  test('renders the shared EmptyState when no workgroups exist', async () => {
    installFetch({ workgroups: [], calls: [] })
    await renderPage('/workgroups')
    await screen.findByTestId('workgroups-empty')
    expect(screen.getByRole('link', { name: '+ New workgroup' })).toBeTruthy()
  })

  test('renders rows: name link, mode chip, member count, leader (fc → em dash)', async () => {
    installFetch({
      workgroups: [
        wg('review-squad'),
        wg('brainstorm', { mode: 'free_collab', leaderMemberId: null, description: '' }),
      ],
      calls: [],
    })
    await renderPage('/workgroups')
    const link = await screen.findByRole('link', { name: 'review-squad' })
    expect(link.getAttribute('href')).toBe('/workgroups/review-squad')

    const lwRow = screen.getByTestId('workgroup-row-review-squad')
    expect(lwRow.textContent).toContain('Leader-Worker')
    expect(lwRow.textContent).toContain('Coder') // leader displayName
    expect(lwRow.textContent).toContain('2') // member count

    const fcRow = screen.getByTestId('workgroup-row-brainstorm')
    expect(fcRow.textContent).toContain('Free collaboration')
    expect(fcRow.textContent).toContain('—') // no leader in fc mode
  })

  test('delete goes through the shared Dialog and fires DELETE on confirm', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups')
    fireEvent.click(await screen.findByTestId('workgroup-delete-review-squad'))

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('review-squad')

    fireEvent.click(screen.getByTestId('workgroup-delete-confirm'))
    await waitFor(() => {
      expect(
        state.calls.some(
          (c) => c.method === 'DELETE' && c.url.endsWith('/api/workgroups/review-squad'),
        ),
      ).toBe(true)
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('/workgroups/new page', () => {
  test('invalid draft disables Create and shows inline errors; a valid draft POSTs and navigates', async () => {
    const state = { workgroups: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups/new')

    const save = (await screen.findByTestId('workgroup-save-button')) as HTMLButtonElement
    // Fresh draft (one empty agent row, no name) is invalid → disabled.
    expect(save.disabled).toBe(true)
    expect(screen.getByText('Agent members need an agent name.')).toBeTruthy()

    fireEvent.change(screen.getByTestId('workgroup-field-name'), {
      target: { value: 'review-squad' },
    })
    fireEvent.change(screen.getByTestId('workgroup-member-agent-0'), {
      target: { value: 'coder' },
    })
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-0'), {
      target: { value: 'Coder' },
    })
    // Still invalid: leader_worker without a leader.
    expect((screen.getByTestId('workgroup-save-button') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Leader-Worker mode requires one agent member as leader.')).toBeTruthy()

    fireEvent.click(screen.getByTestId('workgroup-member-leader-0'))
    const enabledSave = screen.getByTestId('workgroup-save-button') as HTMLButtonElement
    expect(enabledSave.disabled).toBe(false)

    fireEvent.click(enabledSave)
    await waitFor(() => {
      const post = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workgroups'))
      expect(post).toBeTruthy()
      expect(post?.body).toMatchObject({
        name: 'review-squad',
        mode: 'leader_worker',
        leaderDisplayName: 'Coder',
        members: [{ memberType: 'agent', agentName: 'coder', displayName: 'Coder' }],
      })
    })
    // Create navigates to the new resource's detail page.
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workgroups/review-squad')
    })
  })
})

describe('/workgroups/$name detail page', () => {
  test('seeds the form from the stored row and PUTs without a name field', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    await screen.findByRole('heading', { name: 'review-squad' })
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-name') as HTMLInputElement).value).toBe(
        'review-squad',
      )
    })
    const nameInput = screen.getByTestId('workgroup-field-name') as HTMLInputElement
    expect(nameInput.disabled).toBe(true)
    expect((screen.getByTestId('workgroup-member-displayname-0') as HTMLInputElement).value).toBe(
      'Coder',
    )

    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'updated desc' },
    })
    fireEvent.click(screen.getByTestId('workgroup-save-button'))
    await waitFor(() => {
      const put = state.calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/api/workgroups/review-squad'),
      )
      expect(put).toBeTruthy()
      expect(put?.body).toMatchObject({ description: 'updated desc' })
      expect((put?.body as Record<string, unknown>).name).toBeUndefined()
    })
  })

  test('rename button opens a Dialog and POSTs /rename with the new name', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    fireEvent.click(await screen.findByTestId('workgroup-rename-button'))
    const input = (await screen.findByTestId('workgroup-rename-input')) as HTMLInputElement
    expect(input.value).toBe('review-squad')

    // Unchanged name keeps the confirm disabled.
    expect((screen.getByTestId('workgroup-rename-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.change(input, { target: { value: 'audit-squad' } })
    const confirm = screen.getByTestId('workgroup-rename-confirm') as HTMLButtonElement
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)

    await waitFor(() => {
      const post = state.calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroups/review-squad/rename'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ newName: 'audit-squad' })
    })
  })
})

describe('RFC-164 /workgroups wiring', () => {
  test('sidebar nav exposes /workgroups inside the workflows group', () => {
    const nav = readSrc('lib/nav.ts')
    expect(nav).toContain("{ to: '/workgroups', i18nKey: 'nav.workgroups' }")
    const workflowsGroup = nav.slice(nav.indexOf("key: 'workflows'"), nav.indexOf("key: 'tasks'"))
    expect(workflowsGroup).toContain("to: '/workgroups'")
  })

  test('router registers list + new + detail routes (literal before $param)', () => {
    const router = readSrc('router.tsx')
    expect(router).toContain("import { Route as workgroupsRoute } from '@/routes/workgroups'")
    expect(router).toContain(
      "import { Route as workgroupDetailRoute } from '@/routes/workgroups.detail'",
    )
    expect(router).toContain("import { Route as workgroupNewRoute } from '@/routes/workgroups.new'")
    const newIdx = router.indexOf('workgroupNewRoute,')
    const detailIdx = router.indexOf('workgroupDetailRoute,')
    expect(newIdx).toBeGreaterThan(0)
    expect(detailIdx).toBeGreaterThan(newIdx)
  })

  test('new + detail pages share the WorkgroupForm widget (visual parity)', () => {
    const create = readSrc('routes/workgroups.new.tsx')
    const edit = readSrc('routes/workgroups.detail.tsx')
    expect(create).toContain("import { WorkgroupForm } from '@/components/workgroup/WorkgroupForm'")
    expect(edit).toContain("import { WorkgroupForm } from '@/components/workgroup/WorkgroupForm'")
    expect(create).toContain('btn btn--primary')
    expect(edit).toContain('DetailHeaderActions')
  })

  test('zh-CN and en-US both define the workgroups i18n section (key symmetry)', () => {
    // The global i18n-keys-symmetry test guards zh↔en drift; this pins the
    // RFC-164 keys themselves so a rename in one bundle can't slip through.
    const mustExist = [
      'title',
      'newButton',
      'emptyList',
      'colMode',
      'colLeader',
      'modeLeaderWorker',
      'modeFreeCollab',
      'deleteTitle',
      'renameTitle',
      'addAgentMember',
      'addHumanMember',
      'fcSwitchesNotice',
      'fieldMaxRounds',
      'fieldCompletionGate',
    ] as const
    for (const key of mustExist) {
      expect(zhCN.workgroups[key].length, `zh-CN workgroups.${key}`).toBeGreaterThan(0)
      expect(enUS.workgroups[key].length, `en-US workgroups.${key}`).toBeGreaterThan(0)
    }
    const errorKeys = [
      'nameRequired',
      'nameInvalid',
      'membersRequired',
      'agentNameRequired',
      'userRequired',
      'displayNameRequired',
      'displayNameInvalid',
      'displayNameTooLong',
      'displayNameDuplicate',
      'leaderRequired',
      'leaderMustBeAgent',
      'maxRoundsInvalid',
    ] as const
    for (const key of errorKeys) {
      expect(zhCN.workgroups.errors[key].length, `zh-CN workgroups.errors.${key}`).toBeGreaterThan(
        0,
      )
      expect(enUS.workgroups.errors[key].length, `en-US workgroups.errors.${key}`).toBeGreaterThan(
        0,
      )
    }
    expect(zhCN.nav.workgroups).toBe('工作组')
    expect(enUS.nav.workgroups).toBe('Workgroups')
  })
})
