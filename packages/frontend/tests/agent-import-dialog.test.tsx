// RFC-018 T3 — integration coverage for AgentImportDialog.
// Locks the four critical paths in design.md §6.2:
// (1) Parse button disabled when raw input empty
// (2) Paste tab → valid markdown → Parse → preview + Apply forwards result
// (3) Malformed YAML → warning visible + Apply disabled
// (4) currentValue overlap → overwrite banner lists the field

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, test, vi } from 'vitest'
import type { AgentMarkdownParseResult } from '@agent-workflow/shared'
import { AgentImportDialog } from '../src/components/AgentImportDialog'
import { emptyAgent } from '../src/components/AgentForm'

function setup(overrides: Partial<Parameters<typeof AgentImportDialog>[0]> = {}) {
  const onApply = vi.fn<(r: AgentMarkdownParseResult) => void>()
  const onClose = vi.fn()
  const utils = render(
    <AgentImportDialog
      open
      onApply={onApply}
      onClose={onClose}
      currentValue={overrides.currentValue ?? emptyAgent()}
      {...overrides}
    />,
  )
  return { ...utils, onApply, onClose }
}

describe('AgentImportDialog', () => {
  test('Parse is disabled when rawText is empty', () => {
    setup()
    const parseBtn = screen.getByTestId('agent-import-parse') as HTMLButtonElement
    expect(parseBtn.disabled).toBe(true)
  })

  test('paste tab → parse → apply forwards parser result and closes', () => {
    const { onApply, onClose } = setup()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    const textarea = screen.getByTestId('agent-import-textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, {
      target: {
        value: ['---', 'description: A reviewer', 'model: x', '---', 'body line'].join('\n'),
      },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    const applyBtn = screen.getByTestId('agent-import-apply') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(false)
    fireEvent.click(applyBtn)
    expect(onApply).toHaveBeenCalledTimes(1)
    const result = onApply.mock.calls[0]![0]
    expect(result.partial.description).toBe('A reviewer')
    // RFC-115: `model` is no longer a first-class agent field — a legacy
    // `model:` frontmatter key routes into frontmatterExtra, never partial.model.
    expect(result.partial.frontmatterExtra?.model).toBe('x')
    expect(result.partial.bodyMd).toBe('body line')
    expect(onClose).toHaveBeenCalled()
  })

  test('malformed YAML surfaces warning and disables Apply', () => {
    setup()
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: '---\nkey: : :\n---\nbody' },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    const warning = screen.getByTestId('agent-import-warning')
    expect(warning.textContent ?? '').toContain('yaml-parse-failed:')
    const applyBtn = screen.getByTestId('agent-import-apply') as HTMLButtonElement
    expect(applyBtn.disabled).toBe(true)
  })

  test('overwrite banner lists fields the user already edited', () => {
    const current = { ...emptyAgent(), description: 'kept by user', model: 'm0' }
    setup({ currentValue: current })
    fireEvent.click(screen.getByRole('tab', { name: /paste/i }))
    fireEvent.change(screen.getByTestId('agent-import-textarea'), {
      target: { value: '---\ndescription: imported\n---\nbody' },
    })
    fireEvent.click(screen.getByTestId('agent-import-parse'))
    const banner = screen.getByTestId('agent-import-overwrite')
    expect(banner.textContent ?? '').toContain('description')
  })
})
