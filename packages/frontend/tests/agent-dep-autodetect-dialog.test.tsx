// RFC-038 T2 — locks DependencyAutodetectDialog UI:
//   (1) renders one section per non-empty group with all candidates checked
//       by default
//   (2) toggling a checkbox then clicking Import calls onApply with only the
//       checked subset and closes
//   (3) Cancel does NOT call onApply and closes
//   (4) empty result → EmptyState renders, footer collapses to Close only
//   (5) loadFailures surface as muted footer notes

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import { DependencyAutodetectDialog } from '../src/components/agents/DependencyAutodetectDialog'
import type { DetectionResult } from '../src/lib/agent-dep-detect'

const FULL_RESULT: DetectionResult = {
  agents: { candidates: [{ name: 'git-diff-snapshot', description: 'diff' }] },
  skills: { candidates: [{ name: 'playwright-runner' }] },
  mcps: { candidates: [{ name: 'code-review-mcp' }] },
  plugins: { candidates: [{ name: 'schema-validator' }] },
}

const EMPTY_RESULT: DetectionResult = {
  agents: { candidates: [] },
  skills: { candidates: [] },
  mcps: { candidates: [] },
  plugins: { candidates: [] },
}

describe('DependencyAutodetectDialog', () => {
  test('renders four sections with candidates pre-checked', () => {
    render(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={[]}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByTestId('autodetect-section-agents')).toBeTruthy()
    expect(screen.getByTestId('autodetect-section-skills')).toBeTruthy()
    expect(screen.getByTestId('autodetect-section-mcps')).toBeTruthy()
    expect(screen.getByTestId('autodetect-section-plugins')).toBeTruthy()
    const cb = screen.getByTestId(
      'autodetect-checkbox-agents-git-diff-snapshot',
    ) as HTMLInputElement
    expect(cb.checked).toBe(true)
  })

  test('toggle + import → onApply with checked subset only, onClose not called by apply', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={[]}
        onApply={onApply}
        onClose={onClose}
      />,
    )
    // Uncheck the skills candidate.
    fireEvent.click(screen.getByTestId('autodetect-checkbox-skills-playwright-runner'))
    fireEvent.click(screen.getByTestId('autodetect-apply'))
    expect(onApply).toHaveBeenCalledTimes(1)
    const selection = onApply.mock.calls[0]![0]
    expect(selection.agents).toEqual(['git-diff-snapshot'])
    expect(selection.skills).toEqual([])
    expect(selection.mcps).toEqual(['code-review-mcp'])
    expect(selection.plugins).toEqual(['schema-validator'])
    // Apply itself does not close — parent owns dialog open state.
    expect(onClose).not.toHaveBeenCalled()
  })

  test('cancel button does not call onApply', () => {
    const onApply = vi.fn()
    const onClose = vi.fn()
    render(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={[]}
        onApply={onApply}
        onClose={onClose}
      />,
    )
    fireEvent.click(screen.getByTestId('autodetect-cancel'))
    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  test('empty result → EmptyState shown, only Close button in footer', () => {
    const onClose = vi.fn()
    render(
      <DependencyAutodetectDialog
        open
        result={EMPTY_RESULT}
        loadFailures={[]}
        onApply={vi.fn()}
        onClose={onClose}
      />,
    )
    expect(screen.getByTestId('empty-state')).toBeTruthy()
    const closeBtn = screen.getByTestId('autodetect-close')
    fireEvent.click(closeBtn)
    expect(onClose).toHaveBeenCalled()
    expect(screen.queryByTestId('autodetect-apply')).toBeNull()
  })

  test('loadFailures render muted notes for each failed group', () => {
    render(
      <DependencyAutodetectDialog
        open
        result={FULL_RESULT}
        loadFailures={['plugins']}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    const failures = document.querySelectorAll('.agent-dep-autodetect__failures li')
    expect(failures.length).toBe(1)
  })

  test('section hidden when its candidates array is empty', () => {
    const result: DetectionResult = {
      agents: { candidates: [{ name: 'a' }] },
      skills: { candidates: [] },
      mcps: { candidates: [] },
      plugins: { candidates: [] },
    }
    render(
      <DependencyAutodetectDialog
        open
        result={result}
        loadFailures={[]}
        onApply={vi.fn()}
        onClose={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('autodetect-section-skills')).toBeNull()
    expect(screen.queryByTestId('autodetect-section-agents')).toBeTruthy()
  })
})
