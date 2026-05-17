// RFC-032 resolveActiveNav — locks the pathname → active-state mapping.
//
// Why this test exists: PR1 of RFC-032 introduces a 3-group sidebar whose
// highlight state is driven by a pure function. Routing-internal active-state
// helpers (TanStack's `useMatch`) are awkward to assert against in isolation,
// so the shell renders highlight purely from `resolveActiveNav(pathname)`.
// Any future tweak to that mapping (e.g. PR2 lifting /reviews + /clarify out
// of NAV_GROUPS) must keep these case-by-case assertions green to avoid
// silently breaking sidebar highlight on detail pages.

import { describe, expect, test } from 'vitest'
import { resolveActiveNav } from '@/lib/nav'

describe('RFC-032 resolveActiveNav — pathname → group / item / chrome flags', () => {
  test('root path activates the home link, nothing else', () => {
    expect(resolveActiveNav('/')).toEqual({
      onHome: true,
      onSettings: false,
      activeGroup: null,
      activeItemTo: null,
    })
  })

  test('/agents and detail children both activate the agents group', () => {
    expect(resolveActiveNav('/agents')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'agents',
      activeItemTo: '/agents',
    })
    expect(resolveActiveNav('/agents/abc')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'agents',
      activeItemTo: '/agents',
    })
  })

  test('capability sub-items all land in the agents group', () => {
    expect(resolveActiveNav('/skills').activeGroup).toBe('agents')
    expect(resolveActiveNav('/skills').activeItemTo).toBe('/skills')
    expect(resolveActiveNav('/mcps').activeGroup).toBe('agents')
    expect(resolveActiveNav('/mcps').activeItemTo).toBe('/mcps')
    expect(resolveActiveNav('/plugins').activeGroup).toBe('agents')
    expect(resolveActiveNav('/plugins').activeItemTo).toBe('/plugins')
  })

  test('skills detail route still maps to the agents group', () => {
    expect(resolveActiveNav('/skills/123/files')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: 'agents',
      activeItemTo: '/skills',
    })
  })

  test('/workflows + workflow editor deep links activate the workflows group', () => {
    expect(resolveActiveNav('/workflows').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/workflows/edit/x').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/workflows/launch/x').activeGroup).toBe('workflows')
  })

  test('/reviews + /clarify detail routes fall through to the workflows group', () => {
    // PR1 of RFC-032 also lists these in NAV_GROUPS as visible sub-items, so
    // the exact entry depends on the pathname matching one of those entries.
    // For top-level paths the sub-item match wins.
    expect(resolveActiveNav('/reviews').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/reviews').activeItemTo).toBe('/reviews')
    expect(resolveActiveNav('/clarify').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/clarify').activeItemTo).toBe('/clarify')

    // Deep links (detail pages) still resolve through the per-group walk —
    // here they hit the prefix match on '/reviews'+'/' so activeItemTo
    // remains '/reviews'. PR2 removes both entries from NAV_GROUPS, after
    // which the explicit fallback at the bottom of resolveActiveNav kicks
    // in and `activeItemTo` becomes null. That test gets added in PR2.
    expect(resolveActiveNav('/reviews/abc').activeGroup).toBe('workflows')
    expect(resolveActiveNav('/clarify/xyz').activeGroup).toBe('workflows')
  })

  test('/tasks + /repos both belong to the tasks group', () => {
    expect(resolveActiveNav('/tasks').activeGroup).toBe('tasks')
    expect(resolveActiveNav('/tasks/abc').activeGroup).toBe('tasks')
    expect(resolveActiveNav('/repos').activeGroup).toBe('tasks')
  })

  test('/settings and any settings sub-path activates the gear, nothing else', () => {
    expect(resolveActiveNav('/settings')).toEqual({
      onHome: false,
      onSettings: true,
      activeGroup: null,
      activeItemTo: null,
    })
    expect(resolveActiveNav('/settings/runtime')).toEqual({
      onHome: false,
      onSettings: true,
      activeGroup: null,
      activeItemTo: null,
    })
  })

  test('unknown paths produce all-inactive state (defensive default)', () => {
    expect(resolveActiveNav('/random-unknown')).toEqual({
      onHome: false,
      onSettings: false,
      activeGroup: null,
      activeItemTo: null,
    })
  })
})
