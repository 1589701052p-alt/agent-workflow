// RFC-043 T5 — SourceEventsList contract.

import { afterEach, describe, expect, test } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SourceEventsList } from '../src/components/memory/distill-job-detail/SourceEventsList'
import '../src/i18n'

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SourceEventsList', () => {
  test('empty input → EmptyState placeholder', () => {
    render(<SourceEventsList items={[]} />)
    expect(screen.getByTestId('empty-state')).toBeTruthy()
  })

  test('groups items by kind and renders deep links for live rows', () => {
    render(
      <SourceEventsList
        items={[
          {
            kind: 'feedback',
            id: 'tf1',
            summary: 'always typecheck',
            deepLink: '/tasks/t1#feedback-tf1',
            deletedOrMissing: false,
            taskId: 't1',
          },
          {
            kind: 'clarify',
            id: 'cs1',
            summary: 'which framework?',
            deepLink: '/clarify/cs1',
            deletedOrMissing: false,
            taskId: 't2',
          },
        ]}
      />,
    )
    expect(screen.getByTestId('distill-source-events-feedback')).toBeTruthy()
    expect(screen.getByTestId('distill-source-events-clarify')).toBeTruthy()
    const link = screen.getByTestId('distill-source-event-link-tf1') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/tasks/t1#feedback-tf1')
  })

  test('deletedOrMissing row renders greyed without link', () => {
    render(
      <SourceEventsList
        items={[
          {
            kind: 'review',
            id: 'dv-gone',
            summary: '',
            deepLink: '/reviews/dv-gone',
            deletedOrMissing: true,
            taskId: null,
          },
        ]}
      />,
    )
    const row = screen.getByTestId('distill-source-event-row-dv-gone')
    expect(row.className).toContain('is-missing')
    expect(screen.queryByTestId('distill-source-event-link-dv-gone')).toBeNull()
  })

  test('summary falls back to id when empty', () => {
    render(
      <SourceEventsList
        items={[
          {
            kind: 'feedback',
            id: 'tf-empty',
            summary: '',
            deepLink: '/tasks/t/feedback-tf-empty',
            deletedOrMissing: false,
            taskId: 't',
          },
        ]}
      />,
    )
    const link = screen.getByTestId('distill-source-event-link-tf-empty')
    expect(link.textContent).toBe('tf-empty')
  })
})
