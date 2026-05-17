// RFC-035 PR1 — CSS-level guard for the two button variants that were
// referenced from 9 callsites but had no CSS declaration before this RFC.
//
// If anyone deletes these blocks from styles.css the silent-fallback bug
// (where `.btn--ghost` quietly rendered as the default `.btn`) returns.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

describe('RFC-035 btn variants — CSS declarations', () => {
  test('.btn--ghost is declared', () => {
    expect(css.includes('.btn--ghost {')).toBe(true)
  })

  test('.btn--xs is declared', () => {
    expect(css.includes('.btn--xs {')).toBe(true)
  })

  test('.btn--ghost has a hover state', () => {
    expect(css.includes('.btn--ghost:hover')).toBe(true)
  })

  test('.btn--ghost.btn--danger composes with the danger variant', () => {
    expect(css.includes('.btn--ghost.btn--danger {')).toBe(true)
  })
})
