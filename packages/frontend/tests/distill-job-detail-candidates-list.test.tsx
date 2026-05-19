// RFC-043 T5 — CandidatesList contract.

import { afterEach, describe, expect, test } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import type { MemoryDistillCandidateSnapshot } from '@agent-workflow/shared'
import { CandidatesList } from '../src/components/memory/distill-job-detail/CandidatesList'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

// Lightweight TanStack Router harness — CandidatesList renders <Link to="/memory" />,
// which requires being inside a RouterProvider for ARIA + href resolution.
async function renderWithRouter(node: React.ReactNode): Promise<void> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{node}</>,
  })
  const memoryRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/memory',
    component: () => <div>memory</div>,
  })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, memoryRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  render(<RouterProvider router={router} />)
  await waitFor(() => {
    // Router's initial load is async; wait until the component has mounted.
    expect(
      document.body.querySelector(
        '[data-testid="empty-state"], [data-testid^="distill-candidate-row-"]',
      ),
    ).not.toBeNull()
  })
}

function mk(
  overrides: Partial<MemoryDistillCandidateSnapshot> = {},
): MemoryDistillCandidateSnapshot {
  return {
    memoryId: 'c1',
    title: 'always typecheck before push',
    bodyMd: 'body',
    scopeType: 'global',
    scopeId: null,
    distillAction: 'new',
    currentStatus: 'candidate',
    referenceMemoryId: null,
    createdAt: 1,
    ...overrides,
  }
}

describe('CandidatesList', () => {
  test('empty input → EmptyState', async () => {
    await renderWithRouter(<CandidatesList items={[]} />)
    expect(screen.getByTestId('empty-state')).toBeTruthy()
  })

  test('candidate status rows sort before non-candidate, deep-link to /memory', async () => {
    await renderWithRouter(
      <CandidatesList
        items={[
          mk({ memoryId: 'approved-one', currentStatus: 'approved', title: 'A' }),
          mk({ memoryId: 'still-pending', currentStatus: 'candidate', title: 'P', createdAt: 5 }),
        ]}
      />,
    )
    const rows = await screen.findAllByTestId(/^distill-candidate-row-/)
    expect(rows[0]!.getAttribute('data-testid')).toBe('distill-candidate-row-still-pending')
    const link = screen.getByTestId('distill-candidate-link-still-pending') as HTMLAnchorElement
    expect(link.getAttribute('href')).toContain('/memory')
  })

  test('distillAction badge for update_of includes reference memory id in label', async () => {
    await renderWithRouter(
      <CandidatesList
        items={[mk({ memoryId: 'u1', distillAction: 'update_of', referenceMemoryId: 'm-prior' })]}
      />,
    )
    const row = screen.getByTestId('distill-candidate-row-u1')
    expect(row.textContent ?? '').toContain('m-prior')
  })
})
