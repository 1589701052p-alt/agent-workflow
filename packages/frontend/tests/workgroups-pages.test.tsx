// RFC-164 PR-1 — /workgroups {list, detail} route pages + wiring locks.
//
// Locks:
//   1. List page: empty state, row rendering (name link / mode chip / leader
//      displayName with fc em dash), delete via the shared <Dialog> confirm.
//   2. Quick create: the "+ New workgroup" button opens a name+description
//      dialog; Create stays disabled while the name is invalid and POSTs
//      EXACTLY {name, description} (backend defaults the rest), then
//      navigates to the detail page.
//   3. Detail page: launch-readiness banner renders per reason
//      ('no-agent-member' / 'leader-missing') and hides when ready; the
//      config save PUTs the draft with the CURRENT members passed through;
//      leaderless lw groups still save (决策 #21); rename dialog POSTs
//      /rename.
//   4. Member cards: one card per member (role assertions), leader badge,
//      set-leader / remove / add-agent flows each fire a full-document PUT.
//   5. Wiring: router registers list + detail only (no /new route), nav
//      lists /workgroups in the workflows group, zh/en bundles carry the
//      RFC-164 keys (and dropped the obsolete strict-save error keys).

import { readFileSync } from 'node:fs'
import path, { resolve } from 'node:path'
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
  // Unmount React BEFORE clearing the body: an open <Dialog> portals into
  // document.body, and blowing the DOM away first makes React's portal
  // removal throw (happy-dom removeChild DOMException).
  cleanup()
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
      {
        id: 'mem_3',
        memberType: 'agent',
        agentName: 'auditor',
        userId: null,
        displayName: 'Auditor',
        roleDesc: '',
        sortOrder: 2,
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
      if (url.includes('/api/users/lookup')) {
        return json([
          {
            id: 'u1',
            username: 'alice',
            displayName: 'Alice Wang',
            role: 'user',
            status: 'active',
          },
        ])
      }
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
          return json(row ?? wg(name))
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
  const detail = await import('../src/routes/workgroups.detail')
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const listRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups',
    component: list.Route.options.component,
  })
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/workgroups/$name',
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
  return router
}

describe('/workgroups list page', () => {
  test('renders the shared EmptyState when no workgroups exist', async () => {
    installFetch({ workgroups: [], calls: [] })
    await renderPage('/workgroups')
    await screen.findByTestId('workgroups-empty')
    expect(screen.getByTestId('workgroup-new-button')).toBeTruthy()
  })

  test('renders rows: name link, mode chip, leader (fc → em dash)', async () => {
    installFetch({
      workgroups: [
        wg('review-squad'),
        wg('brainstorm', {
          mode: 'free_collab',
          leaderMemberId: null,
          members: [],
          description: '',
        }),
      ],
      calls: [],
    })
    await renderPage('/workgroups')
    const link = await screen.findByRole('link', { name: 'review-squad' })
    expect(link.getAttribute('href')).toBe('/workgroups/review-squad')

    const lwRow = screen.getByTestId('workgroup-row-review-squad')
    expect(lwRow.textContent).toContain('Leader-Worker')
    expect(lwRow.textContent).toContain('Coder') // leader displayName
    expect(lwRow.textContent).toContain('3') // member count

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

describe('/workgroups quick-create dialog', () => {
  test('invalid name disables Create; a valid draft POSTs {name, description} and navigates', async () => {
    const state = { workgroups: [], calls: [] as Recorded['calls'] }
    installFetch(state)
    const router = await renderPage('/workgroups')

    fireEvent.click(await screen.findByTestId('workgroup-new-button'))
    const confirm = (await screen.findByTestId('workgroup-create-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true) // empty name

    fireEvent.change(screen.getByTestId('workgroup-create-name'), {
      target: { value: 'Bad Name!' },
    })
    expect((screen.getByTestId('workgroup-create-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
    // Malformed (non-empty) name earns the inline error.
    expect(
      screen.getByText(
        'Name must start with a lowercase letter / digit, only [a-z0-9_-], at most 128 chars.',
      ),
    ).toBeTruthy()

    fireEvent.change(screen.getByTestId('workgroup-create-name'), {
      target: { value: 'review-squad' },
    })
    fireEvent.change(screen.getByTestId('workgroup-create-description'), {
      target: { value: 'audits PRs' },
    })
    const enabled = screen.getByTestId('workgroup-create-confirm') as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    fireEvent.click(enabled)

    await waitFor(() => {
      const post = state.calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/workgroups'))
      expect(post).toBeTruthy()
      // EXACTLY the two quick-create fields — everything else is a backend default.
      expect(post?.body).toEqual({ name: 'review-squad', description: 'audits PRs' })
    })
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/workgroups/review-squad')
    })
  })
})

describe('/workgroups/$name — readiness banner', () => {
  test('a memberless leader_worker group shows BOTH reasons', async () => {
    installFetch({
      workgroups: [wg('empty-squad', { members: [], leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/empty-squad')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('No agent members yet — the group cannot launch.')
    expect(banner.textContent).toContain(
      'Leader-Worker mode needs one agent member designated as leader.',
    )
  })

  test('a memberless free_collab group shows only the no-agent reason', async () => {
    installFetch({
      workgroups: [wg('brainstorm', { mode: 'free_collab', members: [], leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/brainstorm')
    const banner = await screen.findByTestId('workgroup-readiness-banner')
    expect(banner.textContent).toContain('No agent members yet')
    expect(banner.textContent).not.toContain('Leader-Worker mode needs')
  })

  test('a ready group renders no banner', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    await screen.findByRole('heading', { name: 'review-squad' })
    expect(screen.queryByTestId('workgroup-readiness-banner')).toBeNull()
  })
})

describe('/workgroups/$name — config editing', () => {
  test('config save PUTs the draft with the current members passed through (no name)', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-description') as HTMLInputElement).value).toBe(
        'audits PRs',
      )
    })
    fireEvent.change(screen.getByTestId('workgroup-field-description'), {
      target: { value: 'updated desc' },
    })
    fireEvent.click(screen.getByTestId('workgroup-save-button'))
    await waitFor(() => {
      const put = state.calls.find(
        (c) => c.method === 'PUT' && c.url.endsWith('/api/workgroups/review-squad'),
      )
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.description).toBe('updated desc')
      expect(body.name).toBeUndefined()
      expect(body.leaderDisplayName).toBe('Coder')
      expect(body.members).toEqual([
        { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: '' },
      ])
    })
  })

  test('a leaderless leader_worker group keeps Save ENABLED (lenient save contract)', async () => {
    installFetch({
      workgroups: [wg('review-squad', { leaderMemberId: null })],
      calls: [],
    })
    await renderPage('/workgroups/review-squad')
    await waitFor(() => {
      expect((screen.getByTestId('workgroup-field-description') as HTMLInputElement).value).toBe(
        'audits PRs',
      )
    })
    expect((screen.getByTestId('workgroup-save-button') as HTMLButtonElement).disabled).toBe(false)
  })

  test('rename button opens a Dialog and POSTs /rename with the new name', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')

    fireEvent.click(await screen.findByTestId('workgroup-rename-button'))
    const input = (await screen.findByTestId('workgroup-rename-input')) as HTMLInputElement
    expect(input.value).toBe('review-squad')
    expect((screen.getByTestId('workgroup-rename-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
    fireEvent.change(input, { target: { value: 'audit-squad' } })
    fireEvent.click(screen.getByTestId('workgroup-rename-confirm'))

    await waitFor(() => {
      const post = state.calls.find(
        (c) => c.method === 'POST' && c.url.endsWith('/api/workgroups/review-squad/rename'),
      )
      expect(post).toBeTruthy()
      expect(post?.body).toEqual({ newName: 'audit-squad' })
    })
  })
})

describe('/workgroups/$name — member cards', () => {
  test('renders one card per member with title / type chip / leader badge / reference', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')

    await screen.findByTestId('workgroup-card-Coder')
    const cards = screen.getAllByRole('listitem')
    expect(cards).toHaveLength(3)
    expect(screen.getByRole('heading', { name: 'Coder', level: 3 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Alice', level: 3 })).toBeTruthy()

    // Leader badge only on the leader card; set-leader only on NON-leader agents.
    const coder = screen.getByTestId('workgroup-card-Coder')
    expect(within(coder).getByTestId('workgroup-leader-badge')).toBeTruthy()
    expect(within(coder).queryByTestId('workgroup-set-leader-Coder')).toBeNull()
    const auditor = screen.getByTestId('workgroup-card-Auditor')
    expect(within(auditor).getByTestId('workgroup-set-leader-Auditor')).toBeTruthy()
    const alice = screen.getByTestId('workgroup-card-Alice')
    expect(within(alice).queryByTestId('workgroup-set-leader-Alice')).toBeNull()
    // Human card shows the resolved platform user name, never the raw id.
    await waitFor(() => expect(alice.textContent).toContain('Alice Wang'))
  })

  test('set-leader PUTs the full document with the new leaderDisplayName', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-set-leader-Auditor'))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.leaderDisplayName).toBe('Auditor')
      expect((body.members as unknown[]).length).toBe(3)
    })
  })

  test('remove confirms (two-click) then PUTs without the member; removing the leader clears it', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    const coder = await screen.findByTestId('workgroup-card-Coder')
    const remove = within(coder).getByRole('button', { name: 'Remove' })
    fireEvent.click(remove) // arm
    fireEvent.click(within(coder).getByRole('button', { name: 'Confirm?' }))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.leaderDisplayName).toBeUndefined() // leader removed → flag cleared
      expect(body.members).toEqual([
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: '' },
      ])
    })
  })

  test('edit dialog patches displayName/roleDesc and PUTs', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-member-edit-Alice'))
    const input = (await screen.findByTestId(
      'workgroup-member-displayname-input',
    )) as HTMLInputElement
    expect(input.value).toBe('Alice')
    fireEvent.change(input, { target: { value: 'Alicia' } })
    fireEvent.click(screen.getByTestId('workgroup-edit-member-confirm'))
    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const members = (put?.body as { members: Array<{ displayName: string }> }).members
      expect(members.map((m) => m.displayName)).toEqual(['Coder', 'Alicia', 'Auditor'])
    })
  })

  test('add-agent dialog defaults the alias to the agent name and PUTs the appended member', async () => {
    const state = { workgroups: [wg('review-squad')], calls: [] as Recorded['calls'] }
    installFetch(state)
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))

    const confirm = (await screen.findByTestId('workgroup-add-agent-confirm')) as HTMLButtonElement
    expect(confirm.disabled).toBe(true) // empty draft

    fireEvent.change(screen.getByTestId('workgroup-agent-name-input'), {
      target: { value: 'reviewer' },
    })
    // Alias followed the agent name (editable default).
    expect(
      (screen.getByTestId('workgroup-member-displayname-input') as HTMLInputElement).value,
    ).toBe('reviewer')
    expect((screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement).disabled).toBe(
      false,
    )
    fireEvent.click(screen.getByTestId('workgroup-add-agent-confirm'))

    await waitFor(() => {
      const put = state.calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      const body = put?.body as Record<string, unknown>
      expect(body.leaderDisplayName).toBe('Coder') // preserved
      expect(body.members).toEqual([
        { memberType: 'agent', agentName: 'coder', displayName: 'Coder', roleDesc: 'writes code' },
        { memberType: 'human', userId: 'u1', displayName: 'Alice', roleDesc: 'reviews' },
        { memberType: 'agent', agentName: 'auditor', displayName: 'Auditor', roleDesc: '' },
        { memberType: 'agent', agentName: 'reviewer', displayName: 'reviewer', roleDesc: '' },
      ])
    })
  })

  test('duplicate alias in the add dialog blocks the confirm with an inline error', async () => {
    installFetch({ workgroups: [wg('review-squad')], calls: [] })
    await renderPage('/workgroups/review-squad')
    fireEvent.click(await screen.findByTestId('workgroup-add-agent-member'))
    await screen.findByTestId('workgroup-add-agent-dialog')
    fireEvent.change(screen.getByTestId('workgroup-agent-name-input'), {
      target: { value: 'coder' },
    })
    fireEvent.change(screen.getByTestId('workgroup-member-displayname-input'), {
      target: { value: 'Coder' },
    })
    expect(screen.getByText('Display names must be unique within the group.')).toBeTruthy()
    expect((screen.getByTestId('workgroup-add-agent-confirm') as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})

describe('RFC-164 /workgroups wiring', () => {
  test('sidebar nav exposes /workgroups inside the workflows group', () => {
    const nav = readSrc('lib/nav.ts')
    expect(nav).toContain("{ to: '/workgroups', i18nKey: 'nav.workgroups' }")
    const workflowsGroup = nav.slice(nav.indexOf("key: 'workflows'"), nav.indexOf("key: 'tasks'"))
    expect(workflowsGroup).toContain("to: '/workgroups'")
  })

  test('router registers list + detail routes only (creation is a dialog, no /new route)', () => {
    const router = readSrc('router.tsx')
    expect(router).toContain("import { Route as workgroupsRoute } from '@/routes/workgroups'")
    expect(router).toContain(
      "import { Route as workgroupDetailRoute } from '@/routes/workgroups.detail'",
    )
    expect(router).not.toContain('workgroups.new')
    const detailIdx = router.indexOf('workgroupDetailRoute,')
    const listIdx = router.indexOf('workgroupsRoute,')
    expect(detailIdx).toBeGreaterThan(0)
    expect(listIdx).toBeGreaterThan(detailIdx)
  })

  test('detail page composes the shared form + member cards + header actions', () => {
    const edit = readSrc('routes/workgroups.detail.tsx')
    expect(edit).toContain("import { WorkgroupForm } from '@/components/workgroup/WorkgroupForm'")
    expect(edit).toContain(
      "import { WorkgroupMemberCards } from '@/components/workgroup/WorkgroupMemberCards'",
    )
    expect(edit).toContain('DetailHeaderActions')
    expect(edit).toContain('workgroupLaunchReadiness')
    const list = readSrc('routes/workgroups.tsx')
    expect(list).toContain('buildQuickCreatePayload')
    expect(list).toContain('btn btn--primary')
  })

  test('zh-CN and en-US both define the RFC-164 keys (and dropped the strict-save errors)', () => {
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
      'membersEmpty',
      'memberEdit',
      'memberRemove',
      'setLeaderButton',
      'leaderBadge',
      'addAgentMember',
      'addHumanMember',
      'addAgentTitle',
      'addHumanTitle',
      'editMemberTitle',
      'fcSwitchesNotice',
      'fieldMaxRounds',
      'fieldCompletionGate',
    ] as const
    for (const key of mustExist) {
      expect(zhCN.workgroups[key].length, `zh-CN workgroups.${key}`).toBeGreaterThan(0)
      expect(enUS.workgroups[key].length, `en-US workgroups.${key}`).toBeGreaterThan(0)
    }
    expect(zhCN.workgroups.readiness.noAgentMember.length).toBeGreaterThan(0)
    expect(zhCN.workgroups.readiness.leaderMissing.length).toBeGreaterThan(0)
    expect(enUS.workgroups.readiness.noAgentMember.length).toBeGreaterThan(0)
    expect(enUS.workgroups.readiness.leaderMissing.length).toBeGreaterThan(0)
    const errorKeys = [
      'nameRequired',
      'nameInvalid',
      'agentNameRequired',
      'userRequired',
      'displayNameRequired',
      'displayNameInvalid',
      'displayNameTooLong',
      'displayNameDuplicate',
      'leaderMustBeAgent',
      'maxRoundsInvalid',
    ] as const
    for (const key of errorKeys) {
      expect(zhCN.workgroups.errors[key].length, `zh-CN errors.${key}`).toBeGreaterThan(0)
      expect(enUS.workgroups.errors[key].length, `en-US errors.${key}`).toBeGreaterThan(0)
    }
    // 决策 #21: the strict-save error keys are GONE — leaderless lw groups
    // and empty member sets are save-valid now.
    expect('leaderRequired' in zhCN.workgroups.errors).toBe(false)
    expect('membersRequired' in zhCN.workgroups.errors).toBe(false)
    expect(zhCN.nav.workgroups).toBe('工作组')
    expect(enUS.nav.workgroups).toBe('Workgroups')
  })
})
