// LOCKS: RFC-057 — <RepairChoiceDialog> contract.
//
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §4.2 + §4.3.
// Locks in:
//   - On open, GET /api/tasks/:tid/alerts/:aid/repair-options is fired.
//   - Loading state surfaces, then options render.
//   - Default selection is the first available option.
//   - Unavailable options are disabled in the <Select> (and the preview
//     switches to the unavailable banner once selected — but the Select
//     itself blocks the click).
//   - Clicking "Next" opens the <RepairConfirmModal>.
//   - 404 / 500 from backend surfaces an <ErrorBanner>.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

import type { RepairOptionsResponse } from '@agent-workflow/shared'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { RepairChoiceDialog } from '../src/components/tasks/RepairChoiceDialog'
import '../src/i18n'

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function installFetch(handler: (url: string, init?: RequestInit) => Response): string[] {
  const urls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString()
      urls.push(url)
      return handler(url, init)
    },
  )
  return urls
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const TWO_OPTION_RESPONSE: RepairOptionsResponse = {
  alertId: 'al_1',
  alertRule: 'S3',
  options: [
    {
      id: 'S3.demote-task',
      rule: 'S3',
      labelKey: 'diagnose.repair.S3.demoteTask.label',
      descriptionKey: 'diagnose.repair.S3.demoteTask.desc',
      risk: 'low',
      destructive: false,
      available: true,
      previewSteps: ['Update tasks.status = interrupted.', 'Resume task.'],
    },
    {
      id: 'S3.mark-task-failed',
      rule: 'S3',
      labelKey: 'diagnose.repair.S3.markTaskFailed.label',
      descriptionKey: 'diagnose.repair.S3.markTaskFailed.desc',
      risk: 'high',
      destructive: true,
      available: false,
      unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
      previewSteps: [],
    },
  ],
}

function renderDialog(overrides: Partial<Parameters<typeof RepairChoiceDialog>[0]> = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return render(
    <QueryClientProvider client={qc}>
      <RepairChoiceDialog
        taskId="task_1"
        alertId="al_1"
        alertRule="S3"
        open={true}
        onClose={overrides.onClose ?? (() => {})}
        onApplied={overrides.onApplied ?? (() => {})}
      />
    </QueryClientProvider>,
  )
}

describe('<RepairChoiceDialog />', () => {
  test('fetches repair options and renders the Select + preview', async () => {
    const urls = installFetch(() => jsonResponse(TWO_OPTION_RESPONSE))
    renderDialog()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-choice-preview"]')).not.toBeNull()
    })
    expect(urls[0]).toMatch(/\/api\/tasks\/task_1\/alerts\/al_1\/repair-options$/)
  })

  test('default selection is the first available option', async () => {
    installFetch(() => jsonResponse(TWO_OPTION_RESPONSE))
    renderDialog()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-choice-preview"]')).not.toBeNull()
    })
    // The select's hidden value should be the first available option.
    // We confirm via the preview's step list — only the available option
    // emits steps.
    expect(document.querySelector('[data-testid="repair-preview-steps"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="repair-preview-unavailable"]')).toBeNull()
  })

  test('clicking "Next" opens the confirm modal', async () => {
    installFetch(() => jsonResponse(TWO_OPTION_RESPONSE))
    renderDialog()
    // Wait for the preview to render — that's when the Select + Next button
    // both reflect a valid selection.
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-choice-preview"]')).not.toBeNull()
    })
    const next = document.querySelector('[data-testid="repair-choice-next"]') as HTMLButtonElement
    await waitFor(() => {
      expect(next.disabled).toBe(false)
    })
    fireEvent.click(next)
    await waitFor(
      () => {
        // The apply button only lives inside <RepairConfirmModal>.
        expect(document.querySelector('[data-testid="repair-confirm-apply"]')).not.toBeNull()
      },
      { timeout: 2000 },
    )
  })

  test('empty options list surfaces the empty-state message', async () => {
    installFetch(() =>
      jsonResponse({
        alertId: 'al_1',
        alertRule: 'S3',
        options: [],
      } as RepairOptionsResponse),
    )
    renderDialog()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-choice-empty"]')).not.toBeNull()
    })
  })

  test('404 from backend surfaces an ErrorBanner', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ code: 'not-found', message: 'no such alert' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
    )
    renderDialog()
    await waitFor(() => {
      expect(document.querySelector('.error-box')).not.toBeNull()
    })
  })

  test('Next button is disabled when no option is available', async () => {
    installFetch(() =>
      jsonResponse({
        alertId: 'al_1',
        alertRule: 'S3',
        options: [
          {
            id: 'S3.mark-task-failed',
            rule: 'S3',
            labelKey: 'diagnose.repair.S3.markTaskFailed.label',
            descriptionKey: 'diagnose.repair.S3.markTaskFailed.desc',
            risk: 'high',
            destructive: true,
            available: false,
            unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
            previewSteps: [],
          },
        ],
      } as RepairOptionsResponse),
    )
    renderDialog()
    await waitFor(() => {
      expect(document.querySelector('[data-testid="repair-choice-next"]')).not.toBeNull()
    })
    const next = document.querySelector('[data-testid="repair-choice-next"]') as HTMLButtonElement
    expect(next.disabled).toBe(true)
  })
})
