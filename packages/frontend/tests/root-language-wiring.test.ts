// RFC-025 T4 — source-level guard that __root.tsx wires the language stack.
//
// Why: if a future refactor accidentally drops the hook or the component
// from the sidebar layout, the running app silently regresses (no error,
// just the language switcher disappears). Lock both call sites at the
// source-text level.

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = path.resolve(__dirname, '../src/routes/__root.tsx')

describe('RFC-025 __root.tsx wiring', () => {
  const source = fs.readFileSync(ROOT, 'utf8')

  test('imports useApplyLanguage from @/hooks/useLanguage', () => {
    expect(source).toMatch(/from\s+['"]@\/hooks\/useLanguage['"]/)
    expect(source).toContain('useApplyLanguage')
  })

  test('imports LanguageSwitch from @/components/LanguageSwitch', () => {
    expect(source).toMatch(/from\s+['"]@\/components\/LanguageSwitch['"]/)
    expect(source).toContain('LanguageSwitch')
  })

  test('calls useApplyLanguage() inside the component body', () => {
    expect(source).toMatch(/useApplyLanguage\(\s*\)/)
  })

  test('renders <LanguageSwitch /> inside a sidebar__footer block', () => {
    expect(source).toMatch(/sidebar__footer/)
    expect(source).toMatch(/<LanguageSwitch\s*\/>/)
  })
})
