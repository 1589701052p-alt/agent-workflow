// FilesPicker (launch form, kind=files): derives selected paths from the
// newline-joined value, enforces max cap, and re-packs newline-joined on
// every toggle.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { FilesPicker } from '../src/components/launch/FilesPicker'

function def(extra: Record<string, unknown> = {}): WorkflowInput {
  return {
    kind: 'files',
    key: 'targets',
    label: 'Targets',
    ...extra,
  } as WorkflowInput
}

function wrap(node: React.ReactElement, files: string[]) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['repos', 'files', '/repo'], { files })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FilesPicker', () => {
  test('derives selected set from newline-joined value', () => {
    wrap(
      <FilesPicker def={def()} repoPath="/repo" value={'src/a.ts\nsrc/b.ts'} onChange={() => {}} />,
      ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    )
    const cb = screen.getAllByRole('checkbox') as HTMLInputElement[]
    // Order matches the files list above.
    expect(cb.map((c) => c.checked)).toEqual([true, true, false])
  })

  test('toggling a row emits a newline-joined string', () => {
    const onChange = vi.fn()
    wrap(<FilesPicker def={def()} repoPath="/repo" value="" onChange={onChange} />, [
      'x.ts',
      'y.ts',
    ])
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenLastCalledWith('x.ts')
  })

  test('respects maxCount — toggling past the cap is a no-op', () => {
    const onChange = vi.fn()
    wrap(
      <FilesPicker def={def({ maxCount: 1 })} repoPath="/repo" value="x.ts" onChange={onChange} />,
      ['x.ts', 'y.ts'],
    )
    // Adding y.ts would push selected to 2 → ignored.
    fireEvent.click(screen.getAllByRole('checkbox')[1]!)
    expect(onChange).not.toHaveBeenCalled()
    // But un-toggling x.ts is allowed (set shrinks).
    fireEvent.click(screen.getAllByRole('checkbox')[0]!)
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  test('filter narrows the visible list', () => {
    wrap(<FilesPicker def={def()} repoPath="/repo" value="" onChange={() => {}} />, [
      'alpha.ts',
      'beta.ts',
      'gamma.ts',
    ])
    fireEvent.change(screen.getByPlaceholderText('Filter paths…'), { target: { value: 'be' } })
    const labels = screen.getAllByRole('checkbox').map((cb) => cb.parentElement?.textContent ?? '')
    expect(labels).toEqual(['beta.ts'])
  })

  test('repoPath="" shows the prompt instead of loading', () => {
    wrap(<FilesPicker def={def()} repoPath="" value="" onChange={() => {}} />, [])
    expect(screen.getByText(/Pick a repo first/i)).toBeTruthy()
  })
})
