// RFC-002 tests for SkillsPicker.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  // Unmount via testing-library first — the Select listbox is portaled to
  // document.body, so wiping innerHTML before cleanup() races React's
  // removeChild and crashes happy-dom.
  cleanup()
  vi.restoreAllMocks()
})

// The picker dropdown is the shared <Select> (RFC-036): role=combobox trigger
// + portaled role=listbox. `openPicker` waits for the list query to settle so
// the trigger is enabled, then opens it and returns the listbox.
async function openPicker() {
  const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
  await waitFor(() => expect(trigger.disabled).toBe(false))
  fireEvent.click(trigger)
  return screen.getByRole('listbox')
}

function optionLabels(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('option')
    .map((o) => o.textContent ?? '')
}

describe('SkillsPicker', () => {
  test('renders dropdown with skills not yet in value', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    const list = await openPicker()
    // Placeholder no longer lives in the option list (it's the trigger text).
    expect(optionLabels(list)).toEqual(['a', 'b', 'c'])
  })

  test('selecting an option calls onChange with the skill appended', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b')])
    const onChange = vi.fn()
    wrap(<SkillsPicker value={['existing']} onChange={onChange} />)
    const list = await openPicker()
    // Select rows commit on mousedown (keeps focus before closing).
    fireEvent.mouseDown(within(list).getByText('b'))
    expect(onChange).toHaveBeenCalledWith(['existing', 'b'])
  })

  test('already-selected skills are filtered out of the dropdown', async () => {
    mockSkills([fakeSkill('a'), fakeSkill('b'), fakeSkill('c')])
    wrap(<SkillsPicker value={['b']} onChange={() => {}} />)
    const list = await openPicker()
    expect(optionLabels(list)).toEqual(['a', 'c'])
  })

  test('empty skill list disables the dropdown', async () => {
    mockSkills([])
    wrap(<SkillsPicker value={[]} onChange={() => {}} />)
    const trigger = (await waitFor(() => screen.getByRole('combobox'))) as HTMLButtonElement
    // wait until loading resolves
    await waitFor(() => expect(trigger.disabled).toBe(true))
    // Disabled trigger never opens, so there is no listbox.
    expect(screen.queryByRole('listbox')).toBeNull()
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
