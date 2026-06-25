// RFC-105 — /tasks/$id/preview standalone Markdown preview route.
//
// Four states: file mode renders the markdown via Prose (heading + table roles),
// inline-port mode rebuilds the body from the node-runs outputs, an invalid
// search shows "无效预览链接", and an oversized file shows the size hint with no
// Prose. Asserts via roles (the Prose contract), not DOM structure.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router'

vi.mock('@/api/worktreeFiles', () => ({ fetchWorktreeFile: vi.fn() }))
vi.mock('@/api/client', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, api: { get: vi.fn() } }
})

import '../src/i18n'
import { TaskMarkdownPreviewPage } from '../src/routes/tasks.preview'
import { validatePreviewSearch } from '../src/lib/markdown-preview'
import { fetchWorktreeFile } from '@/api/worktreeFiles'
import { api } from '@/api/client'

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

function renderRoute(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const preview = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id/preview',
    validateSearch: (raw: Record<string, unknown>) => validatePreviewSearch(raw),
    component: TaskMarkdownPreviewPage,
  })
  const taskDetail = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id',
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([preview, taskDetail]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  })
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

const MD = '# Hello\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'

describe('TaskMarkdownPreviewPage', () => {
  test('file mode renders markdown via Prose (heading + table)', async () => {
    vi.mocked(fetchWorktreeFile).mockResolvedValue({
      content: MD,
      oversized: false,
      size: MD.length,
    } as never)
    renderRoute('/tasks/T1/preview?path=docs/report.md')
    expect(await screen.findByRole('heading', { name: 'Hello' })).toBeTruthy()
    expect(await screen.findByRole('table')).toBeTruthy()
    // The back link targets the task detail.
    expect(screen.getByTestId('md-preview-back')).toBeTruthy()
  })

  test('inline-port mode rebuilds body from node-runs outputs', async () => {
    vi.mocked(api.get).mockResolvedValue({
      runs: [],
      outputs: [{ nodeRunId: 'r1', port: 'doc', value: '# FromPort', kind: 'markdown' }],
    } as never)
    renderRoute('/tasks/T1/preview?runId=r1&port=doc')
    expect(await screen.findByRole('heading', { name: 'FromPort' })).toBeTruthy()
  })

  test('invalid search shows the invalid-link message, no fetch', async () => {
    renderRoute('/tasks/T1/preview')
    expect(await screen.findByTestId('md-preview-invalid')).toBeTruthy()
    expect(vi.mocked(fetchWorktreeFile)).not.toHaveBeenCalled()
    expect(vi.mocked(api.get)).not.toHaveBeenCalled()
  })

  test('oversized file shows the size hint and no Prose', async () => {
    vi.mocked(fetchWorktreeFile).mockResolvedValue({
      content: '',
      oversized: true,
      size: 5_000_000,
    } as never)
    renderRoute('/tasks/T1/preview?path=big.md')
    expect(await screen.findByTestId('md-preview-oversized')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Hello' })).toBeNull()
  })
})
