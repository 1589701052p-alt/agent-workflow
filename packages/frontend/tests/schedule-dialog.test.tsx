// RFC-159 — <ScheduleDialog> contract: mode picker, save gating, and the POST body.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'

import { setBaseUrl, setToken } from '../src/stores/auth'
import { ScheduleDialog } from '../src/components/ScheduleDialog'
import '../src/i18n'

vi.mock('@tanstack/react-router', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, useNavigate: () => vi.fn() }
})

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
function installFetch(): FetchCall[] {
  const calls: FetchCall[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      let body: unknown = null
      if (typeof init?.body === 'string' && init.body.length > 0) body = JSON.parse(init.body)
      calls.push({ url: input.toString(), method: init?.method ?? 'GET', body })
      return new Response(JSON.stringify({ id: 'sched-1' }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  )
  return calls
}

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

const LAUNCH = {
  workflowId: 'wf1',
  name: 'nightly',
  repoPath: '/r',
  baseBranch: 'main',
  inputs: {},
}

describe('ScheduleDialog', () => {
  test('renders the four repeat modes; save disabled until a name is entered', () => {
    const r = wrap(<ScheduleDialog open onClose={() => {}} buildLaunchPayload={() => LAUNCH} />)
    // 4 mode options present (Segmented testidPrefix="schedule-kind").
    for (const m of ['interval', 'daily', 'weekly', 'monthly']) {
      expect(r.queryByTestId(`schedule-kind-${m}`)).not.toBeNull()
    }
    const save = r.getByTestId('schedule-save') as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(r.getByTestId('schedule-name'), { target: { value: 'daily audit' } })
    expect((r.getByTestId('schedule-save') as HTMLButtonElement).disabled).toBe(false)
  })

  test('save POSTs {name, launchPayload, scheduleSpec, enabled} to /api/scheduled-tasks', async () => {
    const calls = installFetch()
    const r = wrap(
      <ScheduleDialog
        open
        onClose={() => {}}
        buildLaunchPayload={() => LAUNCH}
        defaultName="daily audit"
      />,
    )
    fireEvent.click(r.getByTestId('schedule-save'))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    const post = calls.find((c) => c.method === 'POST' && c.url.includes('/api/scheduled-tasks'))
    expect(post).toBeDefined()
    const body = post!.body as Record<string, unknown>
    expect(body.name).toBe('daily audit')
    expect(body.launchPayload).toEqual(LAUNCH)
    expect(body.enabled).toBe(true)
    // default mode = daily
    expect(body.scheduleSpec).toMatchObject({ kind: 'daily', at: '09:00' })
  })

  test('switching to interval swaps in the every/unit fields', () => {
    const r = wrap(<ScheduleDialog open onClose={() => {}} buildLaunchPayload={() => LAUNCH} />)
    expect(r.queryByTestId('schedule-every')).toBeNull() // daily by default
    fireEvent.click(r.getByTestId('schedule-kind-interval'))
    expect(r.queryByTestId('schedule-every')).not.toBeNull()
    expect(r.queryByTestId('schedule-at')).toBeNull()
  })
})
