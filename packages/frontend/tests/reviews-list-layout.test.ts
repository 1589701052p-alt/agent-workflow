// Locks in the /reviews list layout fixes the user reported when the
// task-group heading rendered with the workflow link "test" visually
// clipped by the dark ULID <code> pill next to it, and each row showed
// its description as a third line even when description == title.
//
// Source-text assertions only (per CLAUDE.md §Test-with-every-change
// "源代码层文本断言") — the page itself is hard to render under JSDOM
// because TanStack Router needs a full router context, and the visual
// overlap is a pixel/CSS issue anyway. Pinning the rules and the JSX
// conditional gives a cheap regression guard.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')
const REVIEWS_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.tsx')
const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

describe('reviews list layout — Issue: heading pill overlap + duplicate description', () => {
  test('styles.css declares .reviews-group__title as a baseline flex row', () => {
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.reviews-group__title\s*\{[^}]*display:\s*flex/)
    expect(css).toMatch(/\.reviews-group__title\s*\{[^}]*align-items:\s*baseline/)
    expect(css).toMatch(/\.reviews-group__title\s*\{[^}]*gap:/)
  })

  test('styles.css strips the default <code> chrome on .reviews-group__taskid', () => {
    // The default `code {}` rule (styles.css line ~70) paints a bordered
    // panel-coloured pill. Letting that leak through into the h2 was the
    // source of the descender-on-pill clipping. The override below MUST
    // zero out the border + background so the ULID renders as plain
    // muted text inline with the link.
    const css = readFileSync(STYLES_CSS, 'utf8')
    expect(css).toMatch(/\.reviews-group__taskid\s*\{[^}]*border:\s*0/)
    expect(css).toMatch(/\.reviews-group__taskid\s*\{[^}]*background:\s*transparent/)
  })

  test('reviews.tsx suppresses the row description when it duplicates the title', () => {
    const tsx = readFileSync(REVIEWS_TSX, 'utf8')
    expect(tsx).toMatch(/r\.description !== ''\s*&&\s*r\.description !== r\.title/)
  })

  test('reviews.detail.tsx suppresses the header description when it duplicates the title', () => {
    const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')
    expect(tsx).toMatch(
      /data\.summary\.description !== ''\s*&&\s*data\.summary\.description !== data\.summary\.title/,
    )
  })
})
