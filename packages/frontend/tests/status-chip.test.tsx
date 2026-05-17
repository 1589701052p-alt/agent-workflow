// RFC-035 PR1 — render matrix for the unified <StatusChip>.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { StatusChip, type StatusChipKind, type StatusChipSize } from '../src/components/StatusChip'

const KINDS: StatusChipKind[] = ['success', 'warn', 'danger', 'info', 'neutral']
const SIZES: StatusChipSize[] = ['sm', 'md']

describe('<StatusChip />', () => {
  for (const kind of KINDS) {
    for (const size of SIZES) {
      test(`renders kind=${kind} size=${size} with semantic class names`, () => {
        const { container } = render(
          <StatusChip kind={kind} size={size}>
            label
          </StatusChip>,
        )
        const chip = container.querySelector('.status-chip')
        expect(chip, 'chip span').not.toBeNull()
        expect(chip?.className).toContain(`status-chip--${kind}`)
        expect(chip?.className).toContain(`status-chip--${size}`)
      })
    }
  }

  test('size defaults to md when omitted', () => {
    const { container } = render(<StatusChip kind="success">x</StatusChip>)
    expect(container.querySelector('.status-chip')?.className).toContain('status-chip--md')
  })

  test('withDot renders a leading <span class="status-chip__dot" aria-hidden>', () => {
    const { container } = render(
      <StatusChip kind="info" withDot>
        live
      </StatusChip>,
    )
    const dot = container.querySelector('.status-chip__dot')
    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
  })

  test('without explicit aria-label or title, no role is emitted', () => {
    const { container } = render(<StatusChip kind="neutral">plain</StatusChip>)
    expect(container.querySelector('.status-chip')?.getAttribute('role')).toBeNull()
  })

  test('aria-label or title triggers role="status"', () => {
    const { container: a } = render(
      <StatusChip kind="success" aria-label="ok">
        ok
      </StatusChip>,
    )
    expect(a.querySelector('.status-chip')?.getAttribute('role')).toBe('status')

    const { container: b } = render(
      <StatusChip kind="success" title="server reachable">
        ok
      </StatusChip>,
    )
    expect(b.querySelector('.status-chip')?.getAttribute('role')).toBe('status')
  })

  test('data-testid is forwarded', () => {
    const { getByTestId } = render(
      <StatusChip kind="warn" data-testid="my-chip">
        warn
      </StatusChip>,
    )
    expect(getByTestId('my-chip')).not.toBeNull()
  })

  test('className extension is appended after the standard classes', () => {
    const { container } = render(
      <StatusChip kind="danger" className="extra-anchor">
        x
      </StatusChip>,
    )
    const chip = container.querySelector('.status-chip')
    expect(chip?.className).toContain('status-chip--danger')
    expect(chip?.className).toContain('extra-anchor')
  })
})
