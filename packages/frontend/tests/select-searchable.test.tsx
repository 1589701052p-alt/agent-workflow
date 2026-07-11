// LOCKS: RFC-165 UI 精修 — Select's opt-in `searchable` mode (the wizard's
// object pickers filter long agent/workflow/workgroup lists).
//
//   S1 non-searchable selects render NO filter input (back-compat).
//   S2 searchable: typing narrows to case-insensitive label/value matches;
//      zero matches show the empty row; Enter picks the first visible match.
//   S3 the filter resets on every open.

import { afterEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Select } from '../src/components/Select'
import '../src/i18n'

afterEach(cleanup)

const OPTIONS = [
  { value: 'auditor', label: 'auditor' },
  { value: 'builder', label: 'builder' },
  { value: 'reviewer', label: 'Code Reviewer' },
] as const

describe('Select searchable (RFC-165 UI 精修)', () => {
  test('S1 plain mode has no filter input', () => {
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={() => {}} data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    expect(screen.queryByTestId('sel-search')).toBeNull()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  test('S2 typing filters (case-insensitive, label or value); Enter picks first match', () => {
    const onChange = vi.fn()
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={onChange} searchable data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    const input = screen.getByTestId('sel-search')
    fireEvent.change(input, { target: { value: 'code' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option', { name: /Code Reviewer/ })).toBeTruthy()
    fireEvent.change(input, { target: { value: 'zzz' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByText(/无匹配项|No matches/)).toBeTruthy()
    fireEvent.change(input, { target: { value: 'build' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('builder')
  })

  test('S3 filter resets on reopen', () => {
    const { getByTestId } = render(
      <Select value="auditor" options={OPTIONS} onChange={() => {}} searchable data-testid="sel" />,
    )
    fireEvent.click(getByTestId('sel'))
    fireEvent.change(screen.getByTestId('sel-search'), { target: { value: 'code' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.click(getByTestId('sel')) // close
    fireEvent.click(getByTestId('sel')) // reopen
    expect((screen.getByTestId('sel-search') as HTMLInputElement).value).toBe('')
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })
})
