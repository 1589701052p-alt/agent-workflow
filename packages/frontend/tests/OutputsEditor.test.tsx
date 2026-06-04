// OutputsEditor: per-port name + KindSelect. RFC-005 design.md §line 120 let
// users pick a kind from the UI; RFC-080 PR-B swapped the 3-option <select> for
// the shared KindSelect so the full grammar (path<ext> / list<…> / signal) is
// selectable. These tests drive the public Select popover + lock the upward
// (outputs, outputKinds) propagation.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
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

// Stateful harness for multi-step interactions: feeds onChange back into the
// controlled value so the next step renders against the updated kind, while
// still forwarding every change to a spy for assertions.
function mountStateful(
  initialOutputs: string[],
  initialKinds: AgentOutputKindsMap | undefined,
  spy: OnChange,
) {
  function Harness() {
    const [outputs, setOutputs] = useState(initialOutputs)
    const [kinds, setKinds] = useState(initialKinds)
    return (
      <OutputsEditor
        outputs={outputs}
        outputKinds={kinds}
        onChange={(o, k) => {
          spy(o, k)
          setOutputs(o)
          setKinds(k)
        }}
        placeholder="add a port name then Enter"
      />
    )
  }
  return render(<Harness />)
}

// Drives the public Select popover: click the button[role=combobox] trigger,
// then mousedown the matching portaled <li role="option">.
function clickKindOption(triggerLabel: RegExp, optionLabel: string) {
  const trigger = screen.getByRole('combobox', { name: triggerLabel }) as HTMLButtonElement
  fireEvent.click(trigger)
  const opt = Array.from(document.querySelectorAll('li[role="option"]')).find((li) =>
    (li.textContent ?? '').includes(optionLabel),
  )
  if (opt === undefined) throw new Error(`option '${optionLabel}' not found`)
  fireEvent.mouseDown(opt)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('OutputsEditor', () => {
  test('renders one row per declared port with the current kind shown', () => {
    mount(['summary', 'report'], { report: 'markdown_file' }, vi.fn())
    // summary defaults to base string; report is markdown_file → path<md>.
    expect(screen.getByRole('combobox', { name: /Output kind for summary/ }).textContent).toContain(
      'string',
    )
    expect(screen.getByRole('combobox', { name: /Output kind for report/ }).textContent).toContain(
      'file path',
    )
    // the path ext is now a second combobox (RFC-080 follow-up): it shows the
    // Markdown (.md) label rather than a raw 'md' text input.
    const ext = screen.getByRole('combobox', { name: /file extension/ })
    expect((ext.textContent ?? '').toLowerCase()).toContain('markdown')
  })

  test('adding a new port leaves outputKinds untouched (defaults to string)', () => {
    const onChange = vi.fn<OnChange>()
    mount(['summary'], { summary: 'markdown' }, onChange)
    const input = screen.getByPlaceholderText('add a port name then Enter') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'extra_port' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith(['summary', 'extra_port'], { summary: 'markdown' })
  })

  test('selecting markdown on a port writes the outputKinds entry', () => {
    const onChange = vi.fn<OnChange>()
    mount(['report'], undefined, onChange)
    clickKindOption(/Output kind for report/, 'markdown')
    expect(onChange).toHaveBeenCalledWith(['report'], { report: 'markdown' })
  })

  test('flipping the only port back to string drops the key and returns undefined', () => {
    const onChange = vi.fn<OnChange>()
    mount(['report'], { report: 'markdown' }, onChange)
    clickKindOption(/Output kind for report/, 'string')
    expect(onChange).toHaveBeenCalledWith(['report'], undefined)
  })

  test('file path + ext md + list toggle yields list<path<md>> (RFC-080 grammar)', () => {
    const spy = vi.fn<OnChange>()
    mountStateful(['docs'], undefined, spy)
    clickKindOption(/Output kind for docs/, 'file path')
    expect(spy).toHaveBeenLastCalledWith(['docs'], { docs: 'path<*>' })
    // ext is now a Select: pick the Markdown (.md) option from its popover.
    clickKindOption(/file extension/, 'Markdown')
    expect(spy).toHaveBeenLastCalledWith(['docs'], { docs: 'path<md>' })
    fireEvent.click(screen.getByLabelText('list'))
    expect(spy).toHaveBeenLastCalledWith(['docs'], { docs: 'list<path<md>>' })
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
  })
})

describe('AgentForm wiring + KindSelect source-level guards', () => {
  const outputsEditorSrc = readFileSync(
    join(__dirname, '..', 'src', 'components', 'OutputsEditor.tsx'),
    'utf8',
  )
  const agentFormSrc = readFileSync(
    join(__dirname, '..', 'src', 'components', 'AgentForm.tsx'),
    'utf8',
  )

  test('AgentForm.tsx imports OutputsEditor and no longer uses ChipsInput for outputs', () => {
    expect(agentFormSrc).toContain('import { OutputsEditor }')
    expect(agentFormSrc).toContain('<OutputsEditor')
    expect(agentFormSrc).not.toMatch(/<ChipsInput[^>]*value=\{value\.outputs/)
  })

  test('OutputsEditor delegates the kind editor to KindSelect (no bespoke <select>)', () => {
    expect(outputsEditorSrc).toContain("import { KindSelect } from './KindSelect'")
    expect(outputsEditorSrc).toContain('<KindSelect')
    expect(outputsEditorSrc).not.toContain('<select')
  })
})
