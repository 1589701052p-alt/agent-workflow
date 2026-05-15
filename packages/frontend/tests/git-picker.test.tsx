// GitPicker (launch form, kind=git): emit shape per sub-kind + parse existing
// JSON value. The branch sub-kind queries /api/repos/refs; we don't fetch in
// tests — we just confirm the dropdown renders + emits without data.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { WorkflowInput } from '@agent-workflow/shared'
import { GitPicker } from '../src/components/launch/GitPicker'

function def(extra: Record<string, unknown> = {}): WorkflowInput {
  return {
    kind: 'git',
    key: 'target',
    label: 'Target',
    ...extra,
  } as WorkflowInput
}

function wrap(node: React.ReactElement, refs?: { branches: string[] }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (refs !== undefined) qc.setQueryData(['repos', 'refs', '/repo'], refs)
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('GitPicker', () => {
  test('commit-range emits {kind, from, to} JSON', () => {
    const onChange = vi.fn()
    wrap(
      <GitPicker def={def({ gitKind: 'commit-range' })} repoPath="" value="" onChange={onChange} />,
    )
    fireEvent.change(screen.getByPlaceholderText('origin/main'), { target: { value: 'abc' } })
    expect(onChange).toHaveBeenLastCalledWith(
      JSON.stringify({ kind: 'commit-range', from: 'abc', to: '' }),
    )
  })

  test('commit-range round-trips an existing JSON value', () => {
    const onChange = vi.fn()
    wrap(
      <GitPicker
        def={def({ gitKind: 'commit-range' })}
        repoPath=""
        value={JSON.stringify({ kind: 'commit-range', from: 'x', to: 'y' })}
        onChange={onChange}
      />,
    )
    expect((screen.getByPlaceholderText('origin/main') as HTMLInputElement).value).toBe('x')
    expect((screen.getByPlaceholderText('HEAD') as HTMLInputElement).value).toBe('y')
    fireEvent.change(screen.getByPlaceholderText('HEAD'), { target: { value: 'z' } })
    expect(onChange).toHaveBeenLastCalledWith(
      JSON.stringify({ kind: 'commit-range', from: 'x', to: 'z' }),
    )
  })

  test('pr sub-kind emits {kind: pr, number}', () => {
    const onChange = vi.fn()
    wrap(<GitPicker def={def({ gitKind: 'pr' })} repoPath="" value="" onChange={onChange} />)
    fireEvent.change(screen.getByPlaceholderText('123'), { target: { value: '42' } })
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'pr', number: '42' }))
  })

  test('branch sub-kind defaults to gitKind=branch and emits {kind, ref}', () => {
    const onChange = vi.fn()
    // No gitKind in def → defaults to 'branch'. Seed the refs cache so the
    // dropdown has real options to pick from.
    wrap(<GitPicker def={def()} repoPath="/repo" value="" onChange={onChange} />, {
      branches: ['main', 'dev'],
    })
    const select = screen.getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('')
    fireEvent.change(select, { target: { value: 'main' } })
    expect(onChange).toHaveBeenLastCalledWith(JSON.stringify({ kind: 'branch', ref: 'main' }))
  })

  test('malformed existing JSON value is treated as empty', () => {
    const onChange = vi.fn()
    wrap(
      <GitPicker
        def={def({ gitKind: 'commit-range' })}
        repoPath=""
        value="not-json"
        onChange={onChange}
      />,
    )
    expect((screen.getByPlaceholderText('origin/main') as HTMLInputElement).value).toBe('')
    expect((screen.getByPlaceholderText('HEAD') as HTMLInputElement).value).toBe('')
  })
})
