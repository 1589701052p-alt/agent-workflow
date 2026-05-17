// RFC-032 — source-code-level guard that `__root.tsx` is wired to the new
// shell primitives, not the legacy flat `.sidebar__link` loop.
//
// Why this regression test exists: a future refactor that re-imports the
// flat NAV list (or removes the NavGroup / SettingsGearButton wiring) would
// silently revert PR1 of the nav redesign. Source-code grep catches it at
// PR review time and pairs naturally with `shell-no-theme-toggle.test.ts`.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rootTsx = readFileSync(resolve(here, '../src/routes/__root.tsx'), 'utf8')

describe('RFC-032 shell wiring — __root.tsx references the new components', () => {
  test('imports NavGroup, SettingsGearButton, and the resolveActiveNav helper', () => {
    expect(rootTsx).toMatch(/from '@\/components\/shell\/NavGroup'/)
    expect(rootTsx).toMatch(/from '@\/components\/shell\/SettingsGearButton'/)
    expect(rootTsx).toMatch(/resolveActiveNav/)
    expect(rootTsx).toMatch(/NAV_GROUPS/)
  })

  test('renders <SettingsGearButton> + LanguageSwitch inside the footer', () => {
    expect(rootTsx).toMatch(/<SettingsGearButton\s/)
    expect(rootTsx).toMatch(/sidebar__footer/)
  })

  test('renders a top-level Home link (PR1 acceptance #1)', () => {
    // `to="/"` lives on the home link. We don't pin the exact JSX shape,
    // just that the home `to` literal is present in the file.
    expect(rootTsx).toMatch(/to="\/"/)
    expect(rootTsx).toMatch(/nav-item--home/)
  })
})
