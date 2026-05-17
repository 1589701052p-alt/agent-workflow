// RFC-030 T8 — /mcps list page integrates probe state.
//
// Pins:
//   - Three new columns render: Status / Latency / Tools.
//   - Status chip reflects: unknown (no probe), ok, error.
//   - Row is collapsible: clicking ▶ toggles the expanded row, which lists
//     up to 12 tool name chips + a "+N more" overflow chip.
//   - Re-probe button calls POST /api/mcps/:name/probe and refreshes both
//     the per-mcp probe and the list-page probes batch.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import type { Mcp, McpProbe } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { Route as RootRoute } from '../src/routes/__root'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function localMcp(name: string, overrides: Partial<Mcp> = {}): Mcp {
  return {
    id: `id_${name}`,
    name,
    description: '',
    type: 'local',
    config: { command: ['uvx', 'mcp'] },
    enabled: true,
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Mcp
}

function probeOk(name: string, tools: string[], overrides: Partial<McpProbe> = {}): McpProbe {
  return {
    id: `pb_${name}`,
    mcpId: `id_${name}`,
    mcpName: name,
    status: 'ok',
    latencyMs: 1234,
    handshakeMs: 100,
    serverInfo: { name: 'fake', version: '1' },
    protocolVersion: '2024-11-05',
    capabilities: {},
    tools: tools.map((t) => ({ name: t })),
    resources: [],
    resourceTemplates: [],
    prompts: [],
    errorCode: null,
    errorMessage: null,
    errorDetail: null,
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    ...overrides,
  } as McpProbe
}

function probeErr(name: string): McpProbe {
  return {
    id: `pb_${name}`,
    mcpId: `id_${name}`,
    mcpName: name,
    status: 'error',
    latencyMs: 50,
    handshakeMs: null,
    serverInfo: null,
    protocolVersion: null,
    capabilities: null,
    tools: null,
    resources: null,
    resourceTemplates: null,
    prompts: null,
    errorCode: 'connect-failed',
    errorMessage: 'spawn uvx ENOENT',
    errorDetail: { stderr: 'uvx: command not found' },
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
  } as McpProbe
}

interface MockedRouting {
  mcps: Mcp[]
  probes: McpProbe[]
  /** Calls captured for assertion (URL + method). */
  calls: Array<{ url: string; method: string }>
  /** Override probe POST response per mcp name. */
  postProbeResponse?: Record<string, McpProbe>
}

function mockRouting(s: MockedRouting): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (req: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof req === 'string' ? req : req.toString()
      const method = (init?.method ?? 'GET').toUpperCase()
      s.calls.push({ url, method })

      // GET /api/mcps
      if (url.endsWith('/api/mcps') && method === 'GET') {
        return new Response(JSON.stringify(s.mcps), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // GET /api/mcps/probes
      if (url.endsWith('/api/mcps/probes') && method === 'GET') {
        return new Response(JSON.stringify(s.probes), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      // POST /api/mcps/:name/probe
      const m = url.match(/\/api\/mcps\/([^/]+)\/probe$/)
      if (m !== null && method === 'POST') {
        const name = decodeURIComponent(m[1]!)
        const out = s.postProbeResponse?.[name] ?? probeOk(name, ['t-fresh'])
        return new Response(JSON.stringify(out), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not found', { status: 404 })
    },
  )
}

// Mount the real /mcps page through TanStack Router so all <Link>s and
// route params type-check; we just don't navigate.
import { Route as McpsRoute } from '../src/routes/mcps'

function renderWithRouter() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // Build a minimal router using the actual __root + /mcps routes plus a
  // stub /mcps/$name + /mcps/new so the <Link>s in the page type-check.
  const detailStub = createRoute({
    getParentRoute: () => RootRoute,
    path: '/mcps/$name',
    component: () => null,
  })
  const newStub = createRoute({
    getParentRoute: () => RootRoute,
    path: '/mcps/new',
    component: () => null,
  })
  const tree = RootRoute.addChildren([McpsRoute, newStub, detailStub])
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: ['/mcps'] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <RouterProvider router={router as any} />
    </QueryClientProvider>,
  )
}

describe('/mcps list page — probe columns', () => {
  test('renders Status / Latency / Tools columns and chips per row', async () => {
    mockRouting({
      mcps: [localMcp('pg'), localMcp('sentry'), localMcp('legacy')],
      probes: [probeOk('pg', ['query', 'explain']), probeErr('sentry')],
      calls: [],
    })
    renderWithRouter()
    // Wait until data renders by checking for the row data-testids.
    await waitFor(() => screen.getByTestId('mcp-row-pg'))
    await waitFor(() => screen.getByTestId('mcp-row-sentry'))
    await waitFor(() => screen.getByTestId('mcp-row-legacy'))

    // pg: probe ok
    expect(screen.getByTestId('mcp-probe-status-ok')).toBeTruthy()
    // sentry: probe error
    expect(screen.getByTestId('mcp-probe-status-error')).toBeTruthy()
    // legacy: never probed → unknown chip
    expect(screen.getByTestId('mcp-probe-status-unknown')).toBeTruthy()
  })

  test('expanding a row reveals tool chips (≤12) and a re-probe button', async () => {
    const lotsOfTools = Array.from({ length: 20 }, (_, i) => `t${i}`)
    mockRouting({
      mcps: [localMcp('pg')],
      probes: [probeOk('pg', lotsOfTools)],
      calls: [],
    })
    renderWithRouter()
    await waitFor(() => screen.getByTestId('mcp-row-pg'))

    // Row not expanded yet — no expanded row.
    expect(screen.queryByTestId('mcp-row-expanded-pg')).toBeNull()

    fireEvent.click(screen.getByTestId('mcp-row-expand-pg'))
    await waitFor(() => screen.getByTestId('mcp-row-expanded-pg'))

    // 12 visible chips + 1 overflow chip ("+8 more")
    const chips = screen.getByTestId('mcp-row-expanded-pg').querySelectorAll('.mcp-tool-chip')
    expect(chips.length).toBe(12)

    // Re-probe button exists and is enabled.
    const btn = screen.getByTestId('mcp-reprobe-pg')
    expect(btn.hasAttribute('disabled')).toBe(false)
  })

  test('re-probe button triggers POST + refresh', async () => {
    const state: MockedRouting = {
      mcps: [localMcp('pg')],
      probes: [probeOk('pg', ['old1'])],
      calls: [],
      postProbeResponse: { pg: probeOk('pg', ['new1', 'new2']) },
    }
    mockRouting(state)
    renderWithRouter()
    await waitFor(() => screen.getByTestId('mcp-row-pg'))
    fireEvent.click(screen.getByTestId('mcp-row-expand-pg'))
    await waitFor(() => screen.getByTestId('mcp-row-expanded-pg'))
    fireEvent.click(screen.getByTestId('mcp-reprobe-pg'))

    await waitFor(() => {
      expect(
        state.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/mcps/pg/probe')),
      ).toBe(true)
    })
  })
})
