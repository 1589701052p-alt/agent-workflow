// RFC-043 T5 — ConversationSection contract.

import { afterEach, describe, expect, test } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { MemoryDistillSessionView, SessionTree } from '@agent-workflow/shared'
import { ConversationSection } from '../src/components/memory/distill-job-detail/ConversationSection'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

function tree(text: string): SessionTree {
  return {
    sessionId: 's1',
    parentSessionId: null,
    agentName: 'aw-memory-distiller',
    captureComplete: true,
    messages: [
      {
        kind: 'assistant-text',
        text,
        ts: 1,
        messageId: 'm1',
      },
    ],
  }
}

describe('ConversationSection', () => {
  test('loading state', () => {
    render(<ConversationSection sessionData={undefined} loading error={null} />)
    expect(screen.getByText(/loading/i)).toBeTruthy()
  })

  test('error block replaces conversation when query fails', () => {
    render(
      <ConversationSection
        sessionData={undefined}
        loading={false}
        error={<div data-testid="distill-session-load-error">err</div>}
      />,
    )
    expect(screen.getByTestId('distill-session-load-error')).toBeTruthy()
  })

  test('empty attempts → EmptyState placeholder, no conversation', () => {
    const data: MemoryDistillSessionView = { attempts: [] }
    render(<ConversationSection sessionData={data} loading={false} error={null} />)
    expect(screen.getByTestId('empty-state')).toBeTruthy()
  })

  test('multi-attempt picker swaps the rendered tree', () => {
    const data: MemoryDistillSessionView = {
      attempts: [
        {
          attemptIndex: 0,
          rootSessionId: 's1',
          startedAt: 0,
          finishedAt: 1,
          captureFailed: false,
          tree: tree('first attempt body'),
        },
        {
          attemptIndex: 1,
          rootSessionId: 's2',
          startedAt: 2,
          finishedAt: 3,
          captureFailed: false,
          tree: tree('second attempt body'),
        },
      ],
    }
    render(<ConversationSection sessionData={data} loading={false} error={null} />)
    // Defaults to the latest attempt (index 1)
    expect(screen.getByText(/second attempt body/)).toBeTruthy()
    fireEvent.click(screen.getByTestId('distill-attempt-0'))
    expect(screen.getByText(/first attempt body/)).toBeTruthy()
  })

  test('captureFailed attempt shows the warning + EmptyState for the tree', () => {
    const data: MemoryDistillSessionView = {
      attempts: [
        {
          attemptIndex: 0,
          rootSessionId: null,
          startedAt: null,
          finishedAt: null,
          captureFailed: true,
          tree: null,
        },
      ],
    }
    render(<ConversationSection sessionData={data} loading={false} error={null} />)
    expect(screen.getByTestId('distill-conversation-capture-failed')).toBeTruthy()
    expect(screen.getByTestId('empty-state')).toBeTruthy()
  })
})
