// RFC-035 PR2 — CSS-level guard for the three .tabs modifier flavours
// introduced to collapse four bespoke tab implementations into one.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const css = readFileSync(path.resolve(here, '../src/styles.css'), 'utf8')

describe('RFC-035 .tabs modifier CSS', () => {
  test('.tabs--inline is declared', () => {
    expect(css.includes('.tabs--inline {')).toBe(true)
  })

  test('.tabs--inspector is declared', () => {
    expect(css.includes('.tabs--inspector {')).toBe(true)
  })

  test('.tabs--segment is declared', () => {
    expect(css.includes('.tabs--segment {')).toBe(true)
  })

  test('.tabs--segment .tabs__tab--active applies the accent fill', () => {
    expect(css.includes('.tabs--segment .tabs__tab--active')).toBe(true)
  })

  test('.tabs--inspector .tabs__tab tightens padding', () => {
    expect(css.includes('.tabs--inspector .tabs__tab')).toBe(true)
  })

  test('.data-table--compact modifier is declared', () => {
    expect(css.includes('.data-table--compact th')).toBe(true)
  })
})
