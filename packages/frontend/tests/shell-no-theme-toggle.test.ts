// RFC-032 — locks: chrome (`__root.tsx`) carries NO theme-toggle UI.
//
// Why this regression test exists: the RFC explicitly removes the theme
// toggle from the sidebar / chrome (per proposal §目标 and §验收 §7), the
// Settings → Appearance tab being the only theme switch. A future RFC that
// "adds a quick theme toggle to the topbar" needs to update this assertion
// (and the proposal) deliberately, not by accident.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const rootTsx = readFileSync(resolve(here, '../src/routes/__root.tsx'), 'utf8')
const stylesCss = readFileSync(resolve(here, '../src/styles.css'), 'utf8')

describe('RFC-032 — chrome has no theme toggle', () => {
  test('__root.tsx does not import or reference a theme-toggle UI', () => {
    expect(rootTsx).not.toMatch(/toggleTheme/)
    expect(rootTsx).not.toMatch(/ThemeToggle/)
  })

  test('__root.tsx still calls useApplyTheme — the hook itself stays', () => {
    expect(rootTsx).toMatch(/useApplyTheme\(\)/)
  })

  test('styles.css does not define a `.theme-toggle` class', () => {
    expect(stylesCss).not.toMatch(/\.theme-toggle\b/)
  })
})
