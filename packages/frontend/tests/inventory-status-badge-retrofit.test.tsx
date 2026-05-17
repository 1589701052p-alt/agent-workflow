// RFC-035 PR1 — locks the StatusBadge retrofit. The visible API is
// unchanged (callers pass a raw probe status string); internally we now
// render <StatusChip kind size="sm"> with the bucket → kind translation.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { StatusBadge } from '../src/components/inventory/StatusBadge'
import '../src/i18n'

describe('<StatusBadge /> retrofit', () => {
  test('connected → success', () => {
    const { container } = render(<StatusBadge status="connected" />)
    expect(container.querySelector('.status-chip--success')).not.toBeNull()
  })

  test('needs_auth → warn', () => {
    const { container } = render(<StatusBadge status="needs_auth" />)
    expect(container.querySelector('.status-chip--warn')).not.toBeNull()
  })

  test('needs_client_registration → warn', () => {
    const { container } = render(<StatusBadge status="needs_client_registration" />)
    expect(container.querySelector('.status-chip--warn')).not.toBeNull()
  })

  test('failed → danger', () => {
    const { container } = render(<StatusBadge status="failed" />)
    expect(container.querySelector('.status-chip--danger')).not.toBeNull()
  })

  test('disabled → neutral', () => {
    const { container } = render(<StatusBadge status="disabled" />)
    expect(container.querySelector('.status-chip--neutral')).not.toBeNull()
  })

  test('not_initialized → neutral', () => {
    const { container } = render(<StatusBadge status="not_initialized" />)
    expect(container.querySelector('.status-chip--neutral')).not.toBeNull()
  })

  test('unknown status falls back to neutral and surfaces the raw label', () => {
    const { container } = render(<StatusBadge status="some_future_status" />)
    const chip = container.querySelector('.status-chip')
    expect(chip?.className).toContain('status-chip--neutral')
    expect(chip?.textContent ?? '').toBe('some_future_status')
  })

  test('renders the sm size to fit inventory rows', () => {
    const { container } = render(<StatusBadge status="connected" />)
    expect(container.querySelector('.status-chip--sm')).not.toBeNull()
  })
})
