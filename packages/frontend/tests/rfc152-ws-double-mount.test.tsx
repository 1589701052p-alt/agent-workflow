// RFC-152 (D5) — same-task double-mount elimination + invalidation-surface
// non-regression.
//
// Why this file exists: reviews.detail (single-doc page) mounts
// useTaskSync(taskId) while clarify surfaces mount useClarifyWs on the SAME
// /ws/tasks/{taskId} path — pre-RFC-152 that meant two physical WebSocket
// connections per task. The design gate flipped the fix from "remove the
// call sites" (proved wrong: MultiDocReviewView's useTaskSync is the multi-
// doc route's ONLY live subscription — removing call sites would kill all
// review.*/task invalidation there) to hook-layer socket sharing. Locks:
//
//   1. useTaskSync + useClarifyWs on one task ⇒ exactly ONE mock WebSocket
//      construction (the physical-connection oracle).
//   2. The multi-doc invalidation surface does NOT regress: review.* frames
//      still invalidate ['reviews','rounds',nodeRunId] +
//      ['reviews','pending-count'] (+ detail/list) through the shared
//      socket — RFC-142 round history + sidebar badge keys.
//   3. Both rule sets ride the one socket: a clarify.draft.updated frame
//      still fires useClarifyWs's onDraftUpdated callback + detail
//      invalidation while useTaskSync ignores it.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, act } from '@testing-library/react'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { useTaskSync } from '../src/hooks/useTaskSync'
import { useClarifyWs } from '../src/hooks/useClarifyWs'

class MockSocket {
  static instances: MockSocket[] = []
  url: string
  listeners: Record<string, ((e: unknown) => void)[]> = {
    message: [],
    open: [],
    close: [],
    error: [],
  }
  constructor(url: string) {
    this.url = url
    MockSocket.instances.push(this)
  }
  addEventListener(name: string, fn: (e: unknown) => void): void {
    this.listeners[name] = (this.listeners[name] ?? []).concat(fn)
  }
  removeEventListener(): void {}
  close(): void {
    for (const fn of this.listeners.close ?? []) fn(null)
  }
  fireMessage(data: unknown): void {
    for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(data) })
  }
}

const RealWebSocket = globalThis.WebSocket

function DoubleMountHost({
  taskId,
  onDraftUpdated,
}: {
  taskId: string
  onDraftUpdated: (f: { questionId: string }) => void
}) {
  // reviews.detail single-doc scenario: the page's task sync…
  useTaskSync(taskId)
  // …plus a clarify surface subscribed to the SAME task.
  useClarifyWs({ taskId, intermediaryNodeRunId: 'nr_focus', onDraftUpdated })
  return null
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
  MockSocket.instances = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = MockSocket as unknown as typeof WebSocket
})

afterEach(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).WebSocket = RealWebSocket
  vi.restoreAllMocks()
})

function mountHost() {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  const invalidateSpy = vi.spyOn(qc, 'invalidateQueries')
  const onDraftUpdated = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <DoubleMountHost taskId="task_a" onDraftUpdated={onDraftUpdated} />
    </QueryClientProvider>,
  )
  return { invalidateSpy, onDraftUpdated }
}

const keysOf = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls.map((c) => JSON.stringify((c[0] as { queryKey?: unknown[] }).queryKey ?? []))

describe('RFC-152 — same-task double mount rides ONE physical connection', () => {
  test('useTaskSync + useClarifyWs on one task construct exactly one WebSocket', () => {
    mountHost()
    expect(MockSocket.instances.length).toBe(1)
    expect(MockSocket.instances[0]!.url).toContain('/ws/tasks/task_a?token=tok')
  })

  test('review.* invalidation surface does not regress (rounds + pending-count via shared socket)', () => {
    const { invalidateSpy } = mountHost()
    const sock = MockSocket.instances[0]!
    act(() => {
      sock.fireMessage({
        id: 1,
        type: 'review.decision_made',
        nodeRunId: 'nr_r',
        decision: 'approved',
        reviewIteration: 1,
        docVersionDecision: 'approved',
      })
    })
    const keys = keysOf(invalidateSpy as unknown as ReturnType<typeof vi.fn>)
    expect(keys).toContain(JSON.stringify(['reviews', 'detail', 'nr_r']))
    expect(keys).toContain(JSON.stringify(['reviews', 'list']))
    expect(keys).toContain(JSON.stringify(['reviews', 'pending-count']))
    // RFC-142 round history — the multi-doc historical view keys off it.
    expect(keys).toContain(JSON.stringify(['reviews', 'rounds', 'nr_r']))
    // decision_made also moves the host task between statuses.
    expect(keys).toContain(JSON.stringify(['tasks', 'task_a']))
    expect(keys).toContain(JSON.stringify(['tasks', 'task_a', 'node-runs']))
  })

  test('review.selection_changed keeps the multi-doc surface too', () => {
    const { invalidateSpy } = mountHost()
    const sock = MockSocket.instances[0]!
    act(() => {
      sock.fireMessage({
        id: 2,
        type: 'review.selection_changed',
        nodeRunId: 'nr_r',
        docVersionId: 'dv1',
        selection: 'accepted',
      })
    })
    const keys = keysOf(invalidateSpy as unknown as ReturnType<typeof vi.fn>)
    expect(keys).toContain(JSON.stringify(['reviews', 'detail', 'nr_r']))
    expect(keys).toContain(JSON.stringify(['reviews', 'rounds', 'nr_r']))
    expect(keys).toContain(JSON.stringify(['reviews', 'pending-count']))
  })

  test('clarify.draft.updated still reaches useClarifyWs through the shared socket', () => {
    const { invalidateSpy, onDraftUpdated } = mountHost()
    const sock = MockSocket.instances[0]!
    act(() => {
      sock.fireMessage({
        id: -1,
        type: 'clarify.draft.updated',
        nodeRunId: 'nr_focus',
        roundId: 'r1',
        questionId: 'q1',
        editor: { userId: 'u1', displayName: 'U1', role: 'user' },
        ts: 1,
      })
    })
    expect(onDraftUpdated).toHaveBeenCalledTimes(1)
    expect(onDraftUpdated).toHaveBeenCalledWith(expect.objectContaining({ questionId: 'q1' }))
    const keys = keysOf(invalidateSpy as unknown as ReturnType<typeof vi.fn>)
    expect(keys).toContain(JSON.stringify(['clarify', 'detail', 'nr_focus']))
    // A frame for a DIFFERENT node_run does not fire the callback.
    act(() => {
      sock.fireMessage({
        id: -1,
        type: 'clarify.draft.updated',
        nodeRunId: 'nr_other',
        roundId: 'r1',
        questionId: 'q2',
        editor: { userId: 'u1', displayName: 'U1', role: 'user' },
        ts: 2,
      })
    })
    expect(onDraftUpdated).toHaveBeenCalledTimes(1)
  })
})
