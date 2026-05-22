// LOCKS: RFC-057 — <RepairPreview> render contract.
//
// Mirrors design/RFC-057-diagnose-repair-actions/design.md §4.2.
// Locks in:
//   - destructive=true adds .repair-preview--destructive + destructive chip
//   - available=true renders <ol> of preview steps
//   - available=false renders the unavailable banner (with the resolved
//     i18n message from unavailableReasonKey)
//   - risk chip color maps low→success / medium→warn / high→danger

import { afterEach, describe, expect, test } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import type { RepairOption } from '@agent-workflow/shared'
import { RepairPreview } from '../src/components/tasks/RepairPreview'
import '../src/i18n'

afterEach(() => cleanup())

function mkOpt(overrides: Partial<RepairOption> = {}): RepairOption {
  return {
    id: 'S3.demote-task',
    rule: 'S3',
    labelKey: 'diagnose.repair.S3.demoteTask.label',
    descriptionKey: 'diagnose.repair.S3.demoteTask.desc',
    risk: 'low',
    destructive: false,
    available: true,
    previewSteps: ['Step one.', 'Step two.'],
    ...overrides,
  }
}

describe('<RepairPreview />', () => {
  test('renders the description + ordered list of preview steps', () => {
    render(<RepairPreview option={mkOpt()} />)
    const steps = document.querySelector('[data-testid="repair-preview-steps"]')
    expect(steps).not.toBeNull()
    expect(steps?.tagName).toBe('OL')
    expect(steps?.querySelectorAll('li')).toHaveLength(2)
  })

  test('destructive=true adds the destructive class + chip', () => {
    render(<RepairPreview option={mkOpt({ destructive: true })} />)
    const root = document.querySelector('.repair-preview')
    expect(root?.classList.contains('repair-preview--destructive')).toBe(true)
    expect(document.querySelector('[data-testid="repair-preview-destructive"]')).not.toBeNull()
  })

  test('risk=high uses danger chip variant', () => {
    render(<RepairPreview option={mkOpt({ risk: 'high' })} />)
    const chip = document.querySelector('[data-testid="repair-preview-risk"]')
    expect(chip?.className).toMatch(/status-chip--danger/)
  })

  test('available=false renders unavailable banner with the localized reason', () => {
    render(
      <RepairPreview
        option={mkOpt({
          available: false,
          unavailableReasonKey: 'diagnose.repair.S3.unavailable.taskNotRunning',
          previewSteps: [],
        })}
      />,
    )
    expect(document.querySelector('[data-testid="repair-preview-steps"]')).toBeNull()
    const banner = document.querySelector('[data-testid="repair-preview-unavailable"]')
    expect(banner).not.toBeNull()
    // The localized en-US copy includes "no longer in the running state".
    expect(banner?.textContent ?? '').toMatch(/running/i)
  })
})
