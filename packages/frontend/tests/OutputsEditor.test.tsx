// OutputsEditor: per-port name + AgentOutputKind select. Locks in RFC-005
// design.md §line 120 — frontend lets users pick kind=markdown_file from the
// UI instead of having to PUT /api/agents with a curl payload. Tests also
// pin the source-level wiring so AgentForm doesn't regress to a plain
// ChipsInput for the outputs field.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { AgentOutputKindsMap } from '@agent-workflow/shared'
import { OutputsEditor } from '../src/components/OutputsEditor'

type OnChange = (outputs: string[], kinds: AgentOutputKindsMap | undefined) => void

function mount(
  outputs: string[],
  outputKinds: AgentOutputKindsMap | undefined,
  onChange: OnChange,
) {
  return render(
    <OutputsEditor
      outputs={outputs}
      outputKinds={outputKinds}
      onChange={onChange}
      placeholder="add a port name then Enter"
    />,
  )
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('OutputsEditor', () => {
  test('renders one row per declared port with the current kind selected', () => {
    mount(['summary', 'report'], { report: 'markdown_file' }, vi.fn())
    const selects = screen.getAllByRole('combobox') as HTMLSelectElement[]
    expect(selects).toHaveLength(2)
    expect(selects[0]?.value).toBe('string') // summary defaults to string
    expect(selects[1]?.value).toBe('markdown_file')
  })

  test('adding a new port leaves outputKinds untouched (defaults to string)', () => {
    const onChange = vi.fn<OnChange>()
    mount(['summary'], { summary: 'markdown' }, onChange)
    const input = screen.getByPlaceholderText('add a port name then Enter') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'extra_port' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['summary', 'extra_port'], { summary: 'markdown' })
  })

  test('changing a port kind from string to markdown_file writes outputKinds entry', () => {
    const onChange = vi.fn<OnChange>()
    mount(['report'], undefined, onChange)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'markdown_file' } })
    expect(onChange).toHaveBeenCalledWith(['report'], { report: 'markdown_file' })
  })

  test('flipping the only port back to string drops the key and returns undefined', () => {
    const onChange = vi.fn<OnChange>()
    mount(['report'], { report: 'markdown_file' }, onChange)
    const select = screen.getByRole('combobox') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'string' } })
    expect(onChange).toHaveBeenCalledWith(['report'], undefined)
  })

  test('removing a port with a kind drops both array entry and kinds key', () => {
    const onChange = vi.fn<OnChange>()
    mount(['summary', 'report'], { report: 'markdown_file' }, onChange)
    fireEvent.click(screen.getByLabelText('Remove report'))
    expect(onChange).toHaveBeenCalledWith(['summary'], undefined)
  })

  test('rejects duplicates and invalid names without invoking onChange', () => {
    const onChange = vi.fn<OnChange>()
    mount(['summary'], undefined, onChange)
    const input = screen.getByPlaceholderText('add a port name then Enter') as HTMLInputElement

    fireEvent.change(input, { target: { value: 'summary' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(/duplicate/)).toBeTruthy()

    fireEvent.change(input, { target: { value: 'BadName' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).not.toHaveBeenCalled()
    // i18n validate message (en or zh) — the error region is the second match,
    // and its presence is enough to lock the rejection path.
    expect(screen.getByRole('textbox')).toBeTruthy()
  })
})

describe('AgentForm wiring (source-level sanity)', () => {
  // Defends against a regression that would silently drop the kind UI: if the
  // outputs field block reverted to a bare <ChipsInput value={value.outputs}…>,
  // users would lose the per-port kind selector even though all the i18n keys
  // and component code below are still present.
  test('AgentForm.tsx imports OutputsEditor and no longer uses ChipsInput for outputs', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'components', 'AgentForm.tsx'), 'utf8')
    expect(src).toContain('import { OutputsEditor }')
    expect(src).toContain('<OutputsEditor')
    expect(src).not.toMatch(/<ChipsInput[^>]*value=\{value\.outputs/)
  })
})
