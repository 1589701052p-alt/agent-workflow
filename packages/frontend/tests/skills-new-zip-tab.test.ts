// RFC-019: source-layer guards for /skills/new wiring of the Upload ZIP tab.
// Locks two invariants so a future refactor can't silently lose the integration:
//   1. The route imports ImportZipPanel and declares a 'zip' tab value.
//   2. The tab button uses the stable data-testid the panel tests rely on.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const ROUTE_PATH = resolve(import.meta.dirname, '..', 'src', 'routes', 'skills.new.tsx')

describe('/skills/new — Upload ZIP tab wiring', () => {
  test('imports ImportZipPanel component', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("from '@/components/skills/ImportZipPanel'")
    expect(src).toContain('<ImportZipPanel')
  })

  test("declares 'zip' tab value and renders panel for that tab", () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain("'zip'")
    expect(src).toContain("t('skills.tabZip')")
  })

  test('tab button has stable testid skills-tab-zip', () => {
    const src = readFileSync(ROUTE_PATH, 'utf-8')
    expect(src).toContain('data-testid="skills-tab-zip"')
  })
})
