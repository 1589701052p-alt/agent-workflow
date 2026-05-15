// RFC-002 tests for SkillsPicker.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { Skill } from '@agent-workflow/shared'
import { SkillsPicker } from '../src/components/SkillsPicker'
import { setBaseUrl, setToken } from '../src/stores/auth'

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
}

function fakeSkill(name: string, description = ''): Skill {
  return {
    id: name,
    name,
    description,
    sourceKind: 'managed',
    managedPath: `/x/${name}`,
    schemaVersion: 1,
    createdAt: 0,
    updatedAt: 0,
  }
}

function mockSkills(skills: Skill[]) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(skills), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

beforeEach(() => {
  setBaseUrl('http://daemon.test')
  setToken('tok')
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('SkillsPicker', () => {
  test('renders dropdown with skills not yet in value', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    const select = (await waitFor(() => screen.getByRole('combobox'))) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toEqual(['', 'a', 'b', 'c'])
  })

  test('selecting an option calls onChange with the skill appended', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b')])
    const onChange = vi.fn()
    wrap(<SkillsPicker value={['existing']} onChange={onChange} />)
    const select = (await waitFor(() => screen.getByRole('combobox'))) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: 'b' } })
    expect(onChange).toHaveBeenCalledWith(['existing', 'b'])
  })

  test('already-selected skills are filtered out of the dropdown', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={['b']} onChange={() => {}} />)
    const select = (await waitFor(() => screen.getByRole('combobox'))) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBe(3))
    const optionValues = Array.from(select.options).map((o) => o.value)
    expect(optionValues).toEqual(['', 'a', 'c'])
  })

  test('empty skill list disables the dropdown', async () => {
    mockSkills([])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    const select = (await waitFor(() => screen.getByRole('combobox'))) as HTMLSelectElement
    // wait until loading resolves
    await waitFor(() => expect(select.disabled).toBe(true))
    expect(select.options).toHaveLength(1) // only placeholder
  })

  test('load failure hides dropdown and shows muted error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: false, code: 'boom' }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    )
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    await waitFor(() => screen.getByText(/Failed to load skill list/i))
    expect(screen.queryByRole('combobox')).toBeNull()
  })
})
