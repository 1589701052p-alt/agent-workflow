// Locks the contract of goToTaskDetail (src/lib/nav/taskNav.ts), the single
// source of truth for "after a clarify answer / review decision, bounce the
// user to the owning task's detail page and prime its queries" — RFC-023
// bugfix #8 parity (2026-06-24, extended from clarify to the review decision
// flow).
//
// Three call sites depend on it doing EXACTLY: invalidate ['tasks', id] and
// ['tasks', id, 'node-runs'], then navigate to '/tasks/$id' with { id }. If a
// refactor changes the query keys or the route, this fails before the call
// sites silently diverge (the exact drift the dedup audit flags).

import { describe, expect, test, vi } from 'vitest'
import type { QueryClient } from '@tanstack/react-query'
import { goToTaskDetail } from '../src/lib/nav/taskNav'

type Navigate = Parameters<typeof goToTaskDetail>[1]

describe('goToTaskDetail', () => {
  test('invalidates task + node-runs queries then navigates to /tasks/$id', () => {
    const invalidateQueries = vi.fn()
    const navigate = vi.fn()
    const qc = { invalidateQueries } as unknown as QueryClient

    goToTaskDetail(qc, navigate as unknown as Navigate, 'task_123')

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tasks', 'task_123'] })
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ['tasks', 'task_123', 'node-runs'],
    })
    expect(navigate).toHaveBeenCalledWith({ to: '/tasks/$id', params: { id: 'task_123' } })
  })

  test('navigates exactly once — no duplicate bounce', () => {
    const navigate = vi.fn()
    const qc = { invalidateQueries: vi.fn() } as unknown as QueryClient

    goToTaskDetail(qc, navigate as unknown as Navigate, 't1')

    expect(navigate).toHaveBeenCalledTimes(1)
  })

  test('threads the taskId verbatim into both keys and the route params', () => {
    const invalidateQueries = vi.fn()
    const navigate = vi.fn()
    const qc = { invalidateQueries } as unknown as QueryClient

    goToTaskDetail(qc, navigate as unknown as Navigate, 'abc-XYZ')

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['tasks', 'abc-XYZ'] })
    expect(navigate).toHaveBeenCalledWith({ to: '/tasks/$id', params: { id: 'abc-XYZ' } })
  })
})
