// RFC-023 PR-C T25 — left-nav Clarify badge.
//
// Source-level guard: __root.tsx MUST poll /api/clarify/pending-count and
// render a badge with data-testid="clarify-nav-badge" whose visible label
// matches the count (with a "99+" cap above 99). Renaming any of those keys
// breaks the sidebar UX silently; this test catches that regression.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('left-nav Clarify badge wiring (RFC-023 T25)', () => {
  it('__root.tsx imports ClarifyPendingCount + polls /api/clarify/pending-count', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', '__root.tsx'), 'utf8')
    expect(src).toContain('ClarifyPendingCount')
    expect(src).toContain('/api/clarify/pending-count')
    expect(src).toContain("queryKey: ['clarify', 'pending-count']")
  })

  it('__root.tsx renders the badge with data-testid="clarify-nav-badge" + 99+ cap', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'routes', '__root.tsx'), 'utf8')
    expect(src).toContain('data-testid="clarify-nav-badge"')
    // 99+ cap must apply to clarify (same convention as the reviews badge).
    expect(src).toContain("clarifyPendingCount > 99 ? '99+' : clarifyPendingCount")
  })

  it('Clarify appears in the workflows nav group immediately after Reviews', () => {
    // RFC-032 PR1 still surfaces Reviews + Clarify as visible sub-items
    // under the workflows group (placeholders until PR2 lifts both into the
    // shared inbox drawer). The relative ordering — Reviews above Clarify —
    // is what locks the badge column visual.
    const nav = readFileSync(join(__dirname, '..', 'src', 'lib', 'nav.ts'), 'utf8')
    const idxReviews = nav.indexOf("to: '/reviews'")
    const idxClarify = nav.indexOf("to: '/clarify'")
    expect(idxReviews).toBeGreaterThan(-1)
    expect(idxClarify).toBeGreaterThan(idxReviews)
  })
})
