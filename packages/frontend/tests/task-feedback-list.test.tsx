// RFC-041 PR4 — TaskFeedbackList contract.
//
// Locks:
// 1. Renders existing rows from GET /api/tasks/:id/feedback.
// 2. Submit POSTs the trimmed body and clears the textarea on success.
// 3. Rapid double-submit (< 3s) trips the rate-limit banner and skips POST.
// 4. Empty state shown when the backend returns [].
// 5. Distilled chip shown on rows where distilled = true.
// 6. Submit disabled when textarea is empty (whitespace-only counts as empty).

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TaskFeedback } from '@agent-workflow/shared'
import { setBaseUrl, setToken } from '../src/stores/auth'
import { TaskFeedbackList } from '../src/components/tasks/TaskFeedbackList'
import '../src/i18n'

function mkRow(overrides: Partial<TaskFeedback> = {}): TaskFeedback {
  return {
    id: 'fb_1',
    taskId: 'task_a',
    authorUserId: 'u',
    bodyMd: 'remember to prefer plural',
    createdAt: 1000,
    distilled: false,
    distillJobId: null,
    ...overrides,
  }
}

function wrap(taskId = 'task_a') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TaskFeedbackList taskId={taskId} />
    </QueryClientProvider>,
  )
}

interface FetchCall {
  url: string
  method: string
  body: unknown
}

function installFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
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

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('TaskFeedbackList', () => {
  test('renders existing rows', async () => {
    installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [mkRow({ bodyMd: 'first note' })] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('', { status: 200 })
    })
    wrap()
    await waitFor(() => {
      expect(screen.getByText('first note')).toBeTruthy()
    })
  })

  test('empty list shows empty state', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap()
    await waitFor(() => {
      expect(screen.getByTestId('task-feedback-empty')).toBeTruthy()
    })
  })

  test('submit posts trimmed body', async () => {
    const calls = installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({
          feedback: mkRow({ id: 'fb_2', bodyMd: 'second' }),
          distillJobId: 'job_1',
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    })
    wrap()
    const textarea = (await screen.findByTestId('task-feedback-textarea')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '   hello world  ' } })
    const submit = screen.getByTestId('task-feedback-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(false)
    fireEvent.click(submit)
    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post).toBeTruthy()
      expect((post!.body as { bodyMd: string }).bodyMd).toBe('hello world')
    })
  })

  test('rapid double-submit trips rate-limit', async () => {
    installFetch(({ method }) => {
      if (method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify({ feedback: mkRow({ bodyMd: 'x' }), distillJobId: null }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    })
    wrap()
    const textarea = (await screen.findByTestId('task-feedback-textarea')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'note one' } })
    fireEvent.click(screen.getByTestId('task-feedback-submit'))
    // After first submit, textarea clears in onSuccess; type another note.
    await waitFor(() => {
      expect((screen.getByTestId('task-feedback-textarea') as HTMLTextAreaElement).value).toBe('')
    })
    fireEvent.change(screen.getByTestId('task-feedback-textarea'), {
      target: { value: 'note two' },
    })
    fireEvent.click(screen.getByTestId('task-feedback-submit'))
    await waitFor(() => {
      expect(screen.getByTestId('task-feedback-rate-limit')).toBeTruthy()
    })
  })

  test('submit disabled when textarea is whitespace-only', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )
    wrap()
    const textarea = (await screen.findByTestId('task-feedback-textarea')) as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '   \n  ' } })
    const submit = screen.getByTestId('task-feedback-submit') as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  test('distilled chip appears on distilled rows', async () => {
    installFetch(
      () =>
        new Response(
          JSON.stringify({ items: [mkRow({ distilled: true, distillJobId: 'job_1' })] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    )
    wrap()
    await waitFor(() => {
      expect(screen.getByTestId('task-feedback-distilled')).toBeTruthy()
    })
  })
})
