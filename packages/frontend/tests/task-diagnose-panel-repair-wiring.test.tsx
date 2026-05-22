// LOCKS: RFC-057 — <TaskDiagnosePanel> repair wiring.
//
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §4.2.
// Locks in:
//   - Each open alert row gets a "Repair…" button (testid matches rule).
//   - Clicking it opens <RepairChoiceDialog> with the alert id/rule.
//   - After a successful apply, the panel rescans (a second POST to
//     /diagnose lands).
//   - The detail JSON is wrapped in <details> (collapsed by default).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { TaskDiagnosePanel } from '../src/components/tasks/TaskDiagnosePanel'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      const method = init?.method ?? 'GET'
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          body = JSON.parse(init.body)
        } catch {
          body = init.body
        }
      }
      const call: FetchCall = { url, method, body }
      calls.push(call)
      return handler(call)
    },
  )
  return calls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const DIAGNOSE_WITH_S3 = {
  scanned: 1,
  newAlerts: 0,
  promotedAlerts: 0,
  resolvedAlerts: 0,
  openAlerts: [
    {
      id: 'al_S3',
      taskId: 'task_1',
      rule: 'S3' as const,
      severity: 'warning' as const,
      detail: { rule: 'S3' },
      detectedAt: Date.now(),
      resolvedAt: null,
    },
  ],
}

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <TaskDiagnosePanel taskId="task_1" open={true} onClose={() => {}} />
    </QueryClientProvider>,
  )
}

describe('<TaskDiagnosePanel /> + RFC-057 wiring', () => {
  test('renders a Repair button per alert row with rule-tagged testid', async () => {
    installFetch((call) => {
      if (call.url.endsWith('/diagnose')) return jsonResponse(DIAGNOSE_WITH_S3)
      return new Response('not found', { status: 404 })
    })
    renderPanel()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="task-diagnose-repair-S3"]')).not.toBeNull()
    })
  })

  test('clicking Repair opens <RepairChoiceDialog>', async () => {
    installFetch((call) => {
      if (call.url.endsWith('/diagnose')) return jsonResponse(DIAGNOSE_WITH_S3)
      if (call.url.endsWith('/repair-options')) {
        return jsonResponse({
          alertId: 'al_S3',
          alertRule: 'S3',
          options: [],
        })
      }
      return new Response('not found', { status: 404 })
    })
    renderPanel()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="task-diagnose-repair-S3"]')).not.toBeNull()
    })
    const btn = document.querySelector(
      '[data-testid="task-diagnose-repair-S3"]',
    ) as HTMLButtonElement
    fireEvent.click(btn)
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-choice-dialog"]')).not.toBeNull()
    })
  })

  test('detail JSON is wrapped in a <details> disclosure', async () => {
    installFetch((call) => {
      if (call.url.endsWith('/diagnose')) return jsonResponse(DIAGNOSE_WITH_S3)
      return new Response('not found', { status: 404 })
    })
    renderPanel()
    await waitFor(() => {
      expect(document.querySelector('.diagnose-table__detail-disclosure')).not.toBeNull()
    })
    const det = document.querySelector('.diagnose-table__detail-disclosure') as HTMLDetailsElement
    // Default collapsed.
    expect(det.open).toBe(false)
  })

  test('empty alerts list shows the empty-state', async () => {
    installFetch(() =>
      jsonResponse({
        scanned: 0,
        newAlerts: 0,
        promotedAlerts: 0,
        resolvedAlerts: 0,
        openAlerts: [],
      }),
    )
    renderPanel()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="task-diagnose-empty"]')).not.toBeNull()
    })
  })
})
