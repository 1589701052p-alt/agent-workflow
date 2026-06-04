// Locks the multi-doc review "通过 (n/total)" button label to HALF-WIDTH
// parentheses. The button is flex/text-align centered, but a CJK full-width
// closing paren "）" (U+FF09) carries ~0.7em of blank baked into the right
// half of its glyph. Layout centers the advance box (incl. that invisible
// trailing space), so the visible text ends up ~4px left of center — the
// "整体偏左" bug. Half-width "()" keeps the visible label centered.
//
// Source: zh-CN.ts reviews.multiDoc.approveProgress, rendered at
// MultiDocReviewView.tsx (data-testid="multidoc-approve").

import { describe, expect, test } from 'vitest'
import i18n, { setLanguage } from '@/i18n'

describe('multi-doc approve button label centering', () => {
  test('zh-CN approveProgress uses half-width parens, not full-width （）', () => {
    setLanguage('zh-CN')
    const label = i18n.t('reviews.multiDoc.approveProgress', { decided: 24, total: 24 })

    // The full-width parens are what broke centering — must never come back.
    expect(label).not.toContain('（')
    expect(label).not.toContain('）')

    // Still conveys progress, with half-width parens around the count.
    expect(label).toContain('通过')
    expect(label).toContain('(24/24)')

    setLanguage('zh-CN')
  })
})
