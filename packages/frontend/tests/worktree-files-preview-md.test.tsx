// RFC-105 — WorktreeFilePreview "预览" button gate.
//
// A markdown file (`.md`/`.markdown`, not oversized) shows a Preview link to the
// standalone preview route; other extensions and oversized files do not.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'

vi.mock('@/api/worktreeFiles', () => ({
  fetchWorktreeFile: vi.fn(),
  fetchWorktreeTree: vi.fn(),
}))

import '../src/i18n'
import { WorktreeFilePreview } from '../src/components/WorktreeFilesPanel'
import { validatePreviewSearch } from '../src/lib/markdown-preview'
import { fetchWorktreeFile } from '@/api/worktreeFiles'

afterEach(() => {
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function renderPreview(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const index = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <WorktreeFilePreview taskId="T1" path={path} />,
  })
  const preview = createRoute({
    getParentRoute: () => rootRoute,
    path: '/tasks/$id/preview',
    validateSearch: (raw: Record<string, unknown>) => validatePreviewSearch(raw),
    component: () => null,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([index, preview]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  )
}

describe('WorktreeFilePreview preview button', () => {
  test('.md file shows a Preview link to the preview route', async () => {
    vi.mocked(fetchWorktreeFile).mockResolvedValue({
      content: '# Doc',
      oversized: false,
      size: 5,
    } as never)
    await renderPreview('docs/report.md')
    const link = (await screen.findByTestId('worktree-files-preview-btn')) as HTMLAnchorElement
    const href = link.getAttribute('href') ?? ''
    expect(href).toContain('/tasks/T1/preview')
    expect(href).toContain('report.md')
  })

  test('non-markdown file shows no Preview link', async () => {
    vi.mocked(fetchWorktreeFile).mockResolvedValue({
      content: 'plain',
      oversized: false,
      size: 5,
    } as never)
    await renderPreview('docs/notes.txt')
    expect(await screen.findByTestId('worktree-files-download')).toBeTruthy()
    expect(screen.queryByTestId('worktree-files-preview-btn')).toBeNull()
  })

  test('oversized .md file shows no Preview link', async () => {
    vi.mocked(fetchWorktreeFile).mockResolvedValue({
      content: '',
      oversized: true,
      size: 5_000_000,
    } as never)
    await renderPreview('docs/huge.md')
    expect(await screen.findByTestId('worktree-files-preview-oversized')).toBeTruthy()
    expect(screen.queryByTestId('worktree-files-preview-btn')).toBeNull()
  })
})
