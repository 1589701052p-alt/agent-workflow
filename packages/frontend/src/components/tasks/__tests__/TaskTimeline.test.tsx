// RFC-W002 - render test for the TaskTimeline component. Locks that all five
// interaction kinds render in chronological order, the type filter narrows the
// list, the empty state shows for an empty feed, and the node-output jump
// button delegates to the parent's onJump. The pure aggregation is locked in
// packages/shared/tests/interaction-feed.test.ts; this locks the UI wiring.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InteractionFeedResult, InteractionJumpTarget } from '@agent-workflow/shared'

vi.mock('@/api/client', () => ({
  api: {
    get: vi.fn(),
  },
}))

import { api } from '@/api/client'
import { TaskTimeline } from '../TaskTimeline'

const apiGet = vi.mocked(api.get)

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function renderTimeline(
  result: InteractionFeedResult,
  onJump?: (t: InteractionJumpTarget) => void,
) {
  apiGet.mockResolvedValue(result)
  const qc = makeClient()
  return render(
    <QueryClientProvider client={qc}>
      <TaskTimeline taskId="task-1" onJump={onJump ?? (() => undefined)} />
    </QueryClientProvider>,
  )
}

const FIXTURE: InteractionFeedResult = {
  total: 5,
  truncated: false,
  items: [
    {
      id: 'input:task-1',
      kind: 'human_input',
      ts: 1000,
      sortId: 'task-1',
      inputs: { requirement: 'build it' },
    },
    {
      id: 'output:runA',
      kind: 'node_output',
      ts: 2000,
      sortId: 'runA',
      nodeId: 'A',
      nodeRunId: 'runA',
      nodeName: 'Designer',
      outputs: [{ portName: 'design', content: '# plan v1', kind: 'markdown' }],
      jumpTarget: { kind: 'session', nodeRunId: 'runA' },
    },
    {
      id: 'question:round1',
      kind: 'clarify_question',
      ts: 3000,
      sortId: 'round1',
      nodeId: 'B',
      nodeRunId: 'clarifyRun1',
      nodeName: 'Coder',
      questions: [
        {
          id: 'q1',
          title: 'Which framework?',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'React', description: '', recommended: true, recommendationReason: '' },
            { label: 'Vue', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      jumpTarget: { kind: 'clarify', roundId: 'round1', nodeRunId: 'clarifyRun1' },
    },
    {
      id: 'answer:round1',
      kind: 'clarify_answer',
      ts: 4000,
      sortId: 'round1',
      nodeId: 'B',
      nodeRunId: 'clarifyRun1',
      nodeName: 'Coder',
      questions: [
        {
          id: 'q1',
          title: 'Which framework?',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'React', description: '', recommended: false, recommendationReason: '' },
            { label: 'Vue', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['React'],
          customText: '',
        },
      ],
      jumpTarget: { kind: 'clarify', roundId: 'round1', nodeRunId: 'clarifyRun1' },
    },
    {
      id: 'review:dv1',
      kind: 'review_decision',
      ts: 9000,
      sortId: 'dv1',
      nodeId: 'A',
      nodeRunId: 'reviewRun1',
      nodeName: 'Designer',
      review: {
        decision: 'rejected',
        reason: 'needs tests',
        comments: [{ selectedText: 'foo', commentText: 'fix this', author: 'alice' }],
      },
      jumpTarget: { kind: 'review', nodeRunId: 'reviewRun1', docVersionId: 'dv1' },
    },
  ],
}

describe('TaskTimeline', () => {
  beforeEach(() => {
    apiGet.mockReset()
  })

  it('renders all five interaction kinds in chronological order', async () => {
    renderTimeline(FIXTURE)
    // Items appear in ts-ascending order; assert via the ordered list of items.
    const list = await screen.findByTestId('task-timeline-list')
    expect(list).toBeDefined()
    const items = list.querySelectorAll('[data-testid^="task-timeline-item-"]')
    expect(items.length).toBe(5)
    const ids = Array.from(items).map((el) => el.getAttribute('data-testid'))
    expect(ids).toEqual([
      'task-timeline-item-input-task-1',
      'task-timeline-item-output-runA',
      'task-timeline-item-question-round1',
      'task-timeline-item-answer-round1',
      'task-timeline-item-review-dv1',
    ])
  })

  it('renders the node_output content + a jump-to-session button', async () => {
    renderTimeline(FIXTURE)
    // markdown port content renders (the h1 "plan v1")
    expect(await screen.findByText('plan v1')).toBeDefined()
    // jump button delegates to onJump with the session target
    const jump = await screen.findByTestId('task-timeline-jump-output-runA')
    // jump affordance is a real <button> (native implicit role, no explicit attr)
    expect(jump.tagName).toBe('BUTTON')
  })

  it('jump button calls onJump with the session target', async () => {
    const onJump = vi.fn()
    renderTimeline(FIXTURE, onJump)
    const jump = await screen.findByTestId('task-timeline-jump-output-runA')
    fireEvent.click(jump)
    await waitFor(() => {
      expect(onJump).toHaveBeenCalledWith({ kind: 'session', nodeRunId: 'runA' })
    })
  })

  it('type filter narrows the list (review only)', async () => {
    renderTimeline(FIXTURE)
    await screen.findByTestId('task-timeline-list')
    const reviewFilter = screen.getByTestId('task-timeline-filter-review')
    fireEvent.click(reviewFilter)
    await waitFor(() => {
      const items = screen
        .getByTestId('task-timeline-list')
        .querySelectorAll('[data-testid^="task-timeline-item-"]')
      expect(items.length).toBe(1)
      expect(items[0]!.getAttribute('data-testid')).toBe('task-timeline-item-review-dv1')
    })
  })

  it('shows the empty state when the feed has no items', async () => {
    renderTimeline({ items: [], total: 0, truncated: false })
    expect(await screen.findByTestId('task-timeline-empty')).toBeDefined()
  })
})
