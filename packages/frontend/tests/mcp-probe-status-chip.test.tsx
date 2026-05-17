// RFC-030 T8 — McpProbeStatusChip rendering for the four states.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { McpProbeStatusChip, type McpProbeUiStatus } from '../src/components/McpProbeStatusChip'
import '../src/i18n'

describe('McpProbeStatusChip', () => {
  for (const status of ['unknown', 'probing', 'ok', 'error'] as McpProbeUiStatus[]) {
    test(`renders state '${status}' with matching data-testid and class`, () => {
      const { getByTestId } = render(<McpProbeStatusChip status={status} />)
      const chip = getByTestId(`mcp-probe-status-${status}`)
      expect(chip.className).toContain(`mcp-probe-chip--${status}`)
      expect(chip.getAttribute('role')).toBe('status')
    })
  }

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
