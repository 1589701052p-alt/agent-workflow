// RFC-053 PR-E — TaskDiagnosePanel unit test.
//
// Mocks `POST /api/tasks/:id/diagnose`. Asserts:
//   - opening the panel triggers exactly one fetch
//   - empty openAlerts → renders the empty state
//   - non-empty openAlerts → table rows include rule code + severity chip
//   - Re-scan button triggers another fetch

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { TaskDiagnosePanel } from '../src/components/tasks/TaskDiagnosePanel'
import { setBaseUrl, setToken } from '../src/stores/auth'

const realFetch = globalThis.fetch

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('TaskDiagnosePanel', () => {
  beforeEach(() => {
    setBaseUrl('http://daemon.test')
    setToken('tok')
  })
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('renders empty state when openAlerts is empty', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [],
      }),
    ) as unknown as typeof fetch
    const Wrapper = makeWrapper()
    render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    await waitFor(() => {
      expect(document.body.querySelector('[data-testid="task-diagnose-empty"]')).not.toBeNull()
    })
  })

  test('renders table rows for open alerts (rule + severity)', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        scanned: 1,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [
          {
            id: 'a',
            taskId: 't1',
            rule: 'R1',
            severity: 'error',
            detail: { rule: 'R1', actualStatus: 'awaiting_review' },
            detectedAt: Date.UTC(2026, 0, 1),
            resolvedAt: null,
          },
          {
            id: 'b',
            taskId: 't1',
            rule: 'S4',
            severity: 'warning',
            detail: { rule: 'S4', pendingForMs: 600000 },
            detectedAt: Date.UTC(2026, 0, 1),
            resolvedAt: null,
          },
        ],
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
    const r1Row = document.body.querySelector('tr[data-rule="R1"]')
    const s4Row = document.body.querySelector('tr[data-rule="S4"]')
    expect(r1Row).not.toBeNull()
    expect(s4Row).not.toBeNull()
    // Severity chip text uses the i18n key under tasks.diagnose.severity.
    expect(r1Row!.textContent).toMatch(/Error/i)
    expect(s4Row!.textContent).toMatch(/Warning/i)
  })

  test('Re-scan button issues a second POST', async () => {
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
    render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={true} onClose={() => {}} />
      </Wrapper>,
    )
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    const btn = await screen.findByTestId('task-diagnose-rescan')
    fireEvent.click(btn)
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  test('does not fire when open=false', async () => {
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
    render(
      <Wrapper>
        <TaskDiagnosePanel taskId="t1" open={false} onClose={() => {}} />
      </Wrapper>,
    )
    // Dialog mounts but the body is empty when `open=false`, and the
    // mutation is reset/never fired.
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
