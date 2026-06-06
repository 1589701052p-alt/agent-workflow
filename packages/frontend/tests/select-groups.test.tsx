// Locks the optgroup-replacement feature added to the shared Select
// (components/Select.tsx) so ModelSelect's provider grouping can drop the
// native <optgroup>. Verifies: (1) a non-interactive header renders whenever
// the `group` field changes, (2) headers are NOT role="option" so they can't
// be selected or counted as choices, (3) options keep working — selecting a
// grouped option still calls onChange with its value, (4) options without a
// group render no header.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { Select, type SelectOption } from '../src/components/Select'

afterEach(() => {
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  vi.restoreAllMocks()
})

const GROUPED: ReadonlyArray<SelectOption<string>> = [
  { value: '', label: 'pick one' },
  { value: 'a/1', label: 'one', group: 'anthropic' },
  { value: 'a/2', label: 'two', group: 'anthropic' },
  { value: 'o/1', label: 'three', group: 'openai' },
  { value: '__custom__', label: 'custom…' },
]

function open() {
  fireEvent.click(screen.getByRole('combobox'))
}

describe('Select group headers', () => {
  test('renders one header per distinct group, headers are not options', () => {
    render(<Select value="" options={GROUPED} onChange={() => {}} ariaLabel="model" />)
    open()
    const list = screen.getByRole('listbox')
    // Headers visible once each.
    expect(within(list).getByText('anthropic')).toBeTruthy()
    expect(within(list).getByText('openai')).toBeTruthy()
    // Exactly the 5 real options carry role="option"; headers don't.
    expect(within(list).getAllByRole('option')).toHaveLength(GROUPED.length)
  })

  test('selecting a grouped option fires onChange with its value', () => {
    const onChange = vi.fn()
    render(<Select value="" options={GROUPED} onChange={onChange} ariaLabel="model" />)
    open()
    const list = screen.getByRole('listbox')
    fireEvent.mouseDown(within(list).getByText('two'))
    expect(onChange).toHaveBeenCalledWith('a/2')
  })

  test('ungrouped-only options render no header', () => {
    const flat: ReadonlyArray<SelectOption<string>> = [
      { value: 'x', label: 'X' },
      { value: 'y', label: 'Y' },
    ]
    render(<Select value="x" options={flat} onChange={() => {}} ariaLabel="flat" />)
    open()
    const list = screen.getByRole('listbox')
    expect(list.querySelector('.select__group')).toBeNull()
    expect(within(list).getAllByRole('option')).toHaveLength(2)
  })
})
