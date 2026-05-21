// RFC-053 PR-E — TaskDiagnosePanel edge cases not covered in the basic
// suite:
//   - close → reopen triggers a fresh fetch (useEffect re-fire)
//   - large detail JSON (100 nested + multi-row openAlerts) doesn't crash
//   - mutation error path renders error-box

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TaskDiagnosePanel } from '../src/components/tasks/TaskDiagnosePanel'
import { setBaseUrl, setToken } from '../src/stores/auth'

const realFetch = globalThis.fetch

function jsonResponse(body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('TaskDiagnosePanel — reopen + edge cases', () => {
  beforeEach(() => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('close (open=false) then reopen (open=true) triggers a second fetch', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [],
      }),
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const Wrapper = makeWrapper()
    const { rerender } = render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    rerender(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={false} onClose={() => {}} />
      </Wrapper>,
    )
    // Closed: still only 1 fetch
    expect(fetchMock).toHaveBeenCalledTimes(1)
    rerender(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  test('large detail (100 rows + deeply nested) renders without crashing', async () => {
    const openAlerts = Array.from({ length: 100 }).map((_, i) => ({
      id: `a-${i}`,
      taskId: 't1',
      rule: i % 2 === 0 ? 'R1' : 'S4',
      severity: i % 3 === 0 ? 'error' : 'warning',
      detail: {
        rule: i % 2 === 0 ? 'R1' : 'S4',
        nestedDepth: 10,
        nested: makeDeepObject(10),
        rows: Array.from({ length: 20 }).map((__, j) => ({ idx: j, label: `row-${j}` })),
      },
      detectedAt: Date.now() - i * 1000,
      resolvedAt: null,
    }))
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts,
      }),
    ) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="task-diagnose-table"]')).not.toBeNull()
    })
    // 100 rows rendered as <tr data-rule>.
    const rows = document.body.querySelectorAll('tr[data-rule]')
    expect(rows.length).toBe(100)
    // Deeply-nested detail still JSON.stringifies into the <pre> body.
    const firstPre = document.body.querySelector('.diagnose-table__detail')
    expect(firstPre?.textContent ?? '').toContain('nestedDepth')
  })

  test('fetch error path renders error-box', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ ok: false, code: 'internal-error', message: 'boom' }, 500),
    ) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    await waitFor(() => {
      const err = document.body.querySelector('.error-box')
      expect(err).not.toBeNull()
    })
  })

  test('rescan button is disabled while pending', async () => {
    let resolveResp: ((r: Response) => void) | null = null
    globalThis.fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveResp = resolve
        }),
    ) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    const btn = (await screen.findByTestId('task-diagnose-rescan')) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    // Resolve the in-flight fetch so cleanup proceeds.
    resolveResp!(
      jsonResponse({
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [],
      }),
    )
    await waitFor(() => expect(btn.disabled).toBe(false))
  })

  test('taskId change while open triggers a refetch for the new id', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      return jsonResponse({
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [],
        echoUrl: url,
      })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const Wrapper = makeWrapper()
    const onClose = () => {}
    const { rerender } = render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={onClose} />
      </Wrapper>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/api/tasks/t1/diagnose')
    rerender(
      <Wrapper>
        <TaskDiagnosePanel taskId="t2" open={true} onClose={onClose} />
      </Wrapper>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/api/tasks/t2/diagnose')
  })
})

function makeDeepObject(depth: number): Record<string, unknown> {
  let cur: Record<string, unknown> = { leaf: true, depth: 0 }
  for (let i = 1; i < depth; i++) {
    cur = { depth: i, child: cur }
  }
  return cur
}
