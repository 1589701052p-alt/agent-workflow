// EnumPicker (launch form, kind=enum): value packing rules — single emits
// the bare string, multi emits a JSON array, allowOther packs custom input.

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { EnumPicker } from '../src/components/launch/EnumPicker'

function def(extra: Record<string, unknown>): WorkflowInput {
  return {
    kind: 'enum',
    key: 'flavor',
    label: 'Flavor',
    ...extra,
  } as WorkflowInput
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('EnumPicker', () => {
  test('single-select packs as the bare string', () => {
    const onChange = vi.fn()
    render(<EnumPicker def={def({ choices: ['a', 'b', 'c'] })} value="" onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('b'))
    expect(onChange).toHaveBeenCalledWith('b')
  })

  test('single-select reflects existing value as checked', () => {
    const onChange = vi.fn()
    render(<EnumPicker def={def({ choices: ['a', 'b'] })} value="a" onChange={onChange} />)
    const a = screen.getByLabelText('a') as HTMLInputElement
    const b = screen.getByLabelText('b') as HTMLInputElement
    expect(a.checked).toBe(true)
    expect(b.checked).toBe(false)
  })

  test('multi-select packs as a JSON array and toggles in/out', () => {
    const onChange = vi.fn()
    render(
      <EnumPicker
        def={def({ choices: ['a', 'b', 'c'], multiSelect: true })}
        value=""
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByLabelText('a'))
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify(['a']))
    onChange.mockClear()

    // Render again with the accumulated value to simulate parent state.
    document.body.innerHTML = ''
    render(
      <EnumPicker
        def={def({ choices: ['a', 'b', 'c'], multiSelect: true })}
        value={JSON.stringify(['a'])}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByLabelText('c'))
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify(['a', 'c']))

    // Toggling an already-selected choice removes it.
    document.body.innerHTML = ''
    onChange.mockClear()
    render(
      <EnumPicker
        def={def({ choices: ['a', 'b', 'c'], multiSelect: true })}
        value={JSON.stringify(['a', 'c'])}
        onChange={onChange}
      />,
    )
    fireEvent.click(screen.getByLabelText('a'))
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify(['c']))
  })

  test('multi-select with malformed existing value falls back to empty set', () => {
    const onChange = vi.fn()
    render(
      <EnumPicker
        def={def({ choices: ['a', 'b'], multiSelect: true })}
        value="not-json"
        onChange={onChange}
      />,
    )
    const a = screen.getByLabelText('a') as HTMLInputElement
    expect(a.checked).toBe(false)
    fireEvent.click(a)
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify(['a']))
  })

  test('allowOther adds a custom value via the Add button', () => {
    const onChange = vi.fn()
    render(
      <EnumPicker
        def={def({ choices: ['a'], multiSelect: true, allowOther: true })}
        value=""
        onChange={onChange}
      />,
    )
    const otherInput = screen.getByPlaceholderText('Other (custom)…') as HTMLInputElement
    fireEvent.change(otherInput, { target: { value: 'custom-x' } })
    fireEvent.click(screen.getByText('Add'))
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify(['custom-x']))
  })

  test('Add button disabled when other input is blank/whitespace', () => {
    render(
      <EnumPicker
        def={def({ choices: ['a'], allowOther: true })}
        value=""
        onChange={() => {}}
      />,
    )
    const addBtn = screen.getByText('Add') as HTMLButtonElement
    expect(addBtn.disabled).toBe(true)
    const otherInput = screen.getByPlaceholderText('Other (custom)…') as HTMLInputElement
    fireEvent.change(otherInput, { target: { value: '   ' } })
    expect(addBtn.disabled).toBe(true)
  })
})
