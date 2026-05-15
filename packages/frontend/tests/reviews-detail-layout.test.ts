// Locks in the review detail page layout fixes reported on
// /reviews/01KRPE30VQT3R4G24PV3ZAG82D:
//   1. The comment column must sit on the right via a grid layout in
//      styles.css. (Originally an <aside class="review-detail__sidebar">;
//      after the May 2026 bubble-redesign feedback it became
//      <div class="review-detail__bubbles"> — see review-detail-bubble-
//      redesign.test.ts for the bubble-specific locks.)
//   2. The three footer buttons must be spaced via `.review-detail__footer`
//      flex rules.
//   3. Buttons must NOT carry inline `<kbd>A|I|R</kbd>` keyboard hints —
//      the keyboard handler in the route's useEffect still fires for those
//      letters, but the visual hint inside the button label is gone.
//
// Source-text assertions only (per CLAUDE.md §Test-with-every-change "源
// 代码层文本断言"): JSDOM can't evaluate CSS positioning, so the lowest-cost
// regression guard is to pin the CSS rules and the JSX shape directly. If
// any of these flip back, the user's feedback re-emerges immediately.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

describe('review detail layout — Issue: sidebar position + footer spacing + no kbd', () => {
  test('styles.css declares the .review-detail__layout grid with a fixed right column', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*display:\s*grid/)
    expect(css).toMatch(/\.review-detail__layout\s*\{[^}]*grid-template-columns:[^}]*1fr[^}]*\d+px/)
  })

  test('styles.css declares the right comment column as a relative positioning context', () => {
    // Originally `.review-detail__sidebar` was sticky with a left border.
    // The bubble-redesign turned the column into a relative container so
    // absolutely-positioned bubbles can ride the document scroll. The
    // bubble-specific locks live in review-detail-bubble-redesign.test.ts;
    // here we just guard that *some* relative-positioned right column
    // exists.
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__bubbles\s*\{[^}]*position:\s*relative/)
  })

  test('styles.css declares .review-detail__footer with flex gap (no longer collapsed)', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.review-detail__footer\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.review-detail__footer\s*\{[^}]*gap:/)
  })

  test('reviews.detail.tsx does not render <kbd> shortcut hints inside the footer buttons', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    // The three footer buttons are immediately recognizable by their i18n keys.
    // They must NOT carry the inline `<kbd>A</kbd>` / `<kbd>I</kbd>` /
    // `<kbd>R</kbd>` letter hints that the user reported as visual noise.
    expect(tsx).not.toMatch(/reviews\.approveButton'\)\}\s*<kbd>A<\/kbd>/)
    expect(tsx).not.toMatch(/reviews\.iterateButton'\)\}\s*<kbd>I<\/kbd>/)
    expect(tsx).not.toMatch(/reviews\.rejectButton'\)\}\s*<kbd>R<\/kbd>/)
  })

  test('reviews.detail.tsx keeps the A/I/R keyboard handler — feature is still keyboard-driven', () => {
    // Removing the visual kbd hint must not have deleted the actual handler.
    // The handler lives in a useEffect that listens on window keydown and
    // dispatches onApprove/onIterate/onReject for the lowercased keys.
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(/if \(k === 'a'\) void onApprove\(\)/)
    expect(tsx).toMatch(/else if \(k === 'r'\) void onReject\(\)/)
    expect(tsx).toMatch(/else if \(k === 'i'\) void onIterate\(\)/)
  })
})
