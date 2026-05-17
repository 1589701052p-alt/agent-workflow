// RFC-030 T8 — McpProbeStatusChip rendering for the four states.
// RFC-035: chip now renders <StatusChip>; assertions use semantic kind
// class + data-testid + role rather than the legacy `mcp-probe-chip` class
// (kept only as CSS fallback during the RFC-035 cleanup window).

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { McpProbeStatusChip, type McpProbeUiStatus } from '../src/components/McpProbeStatusChip'
import '../src/i18n'

const KIND: Record<McpProbeUiStatus, string> = {
  unknown: 'neutral',
  probing: 'info',
  ok: 'success',
  error: 'danger',
}

describe('McpProbeStatusChip', () => {
  for (const status of ['unknown', 'probing', 'ok', 'error'] as McpProbeUiStatus[]) {
    test(`renders state '${status}' with matching data-testid and StatusChip kind`, () => {
      const { getByTestId } = render(<McpProbeStatusChip status={status} />)
      const chip = getByTestId(`mcp-probe-status-${status}`)
      expect(chip.className).toContain(`status-chip--${KIND[status]}`)
      expect(chip.className).toContain('status-chip--sm')
      expect(chip.getAttribute('role')).toBe('status')
    })
  }

  test('renders a leading dot anchor for the live indicator', () => {
    const { getByTestId } = render(<McpProbeStatusChip status="probing" />)
    const chip = getByTestId('mcp-probe-status-probing')
    expect(chip.querySelector('.status-chip__dot')).not.toBeNull()
  })

  test('aria-label is the localised status text', () => {
    const { getByTestId } = render(<McpProbeStatusChip status="ok" />)
    const chip = getByTestId('mcp-probe-status-ok')
    const label = chip.getAttribute('aria-label')
    expect(label === null || label.length === 0).toBe(false)
  })

  test('title falls back to status label when no override provided', () => {
    const { getByTestId } = render(<McpProbeStatusChip status="error" />)
    expect(getByTestId('mcp-probe-status-error').getAttribute('title')).toBeTruthy()
  })

  test('title override is honoured (e.g. errorMessage)', () => {
    const { getByTestId } = render(<McpProbeStatusChip status="error" title="spawn uvx ENOENT" />)
    expect(getByTestId('mcp-probe-status-error').getAttribute('title')).toBe('spawn uvx ENOENT')
  })
})
