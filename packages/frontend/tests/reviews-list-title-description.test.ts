// Locks in the Reviews list table rendering of title + description from
// the review node definition (RFC-005 ReviewNodeSchema).
//
// User reported "评审页签内的表格...只放评审节点ID" — we surface the
// human-readable title (with the nodeId still visible as a subline for
// debug-ability) plus the description.
//
// Source-text assertions only (per CLAUDE.md §Test-with-every-change "源
// 代码层文本断言"): reviews.tsx renders inside a TanStack Router
// `createRoute` which is awkward to render in JSDOM without a full
// RouterProvider stack; the lowest-cost regression guard is to pin the
// JSX shape directly. If any of these flip back, the user's feedback
// re-emerges immediately.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REVIEWS_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.tsx')
const STYLES_CSS = resolve(__dirname, '..', 'src', 'styles.css')

describe('reviews list — title + description column', () => {
  const tsx = readFileSync(REVIEWS_TSX, 'utf8')

  test('renders r.title prominently when it is set and differs from nodeId', () => {
    expect(tsx).toMatch(/const hasTitle = r\.title !== '' && r\.title !== r\.reviewNodeId/)
    expect(tsx).toMatch(/className="reviews-row__title">\{r\.title\}/)
  })

  test('falls back to the chip-styled reviewNodeId code when hasTitle is false', () => {
    // Node id is rendered with the same rounded-border chip style used by the
    // skills page "source" column, so the table reads as a uniform metadata
    // pill rather than a bare monospace token.
    expect(tsx).toMatch(/<code className="chip chip--tight">\{r\.reviewNodeId\}<\/code>/)
  })

  test('renders r.description on its own muted line when non-empty', () => {
    expect(tsx).toMatch(/r\.description !== ''/)
    expect(tsx).toMatch(/className="muted reviews-row__desc">\{r\.description\}/)
  })

  test('does NOT use the legacy "<code>{nodeId}</code> — {title}" inline form', () => {
    // Old shape was:
    //   <code>{r.reviewNodeId}</code>
    //   {r.title !== '' && r.title !== r.reviewNodeId && ` — ${r.title}`}
    // Lock that exact inline-em-dash pattern out so we never regress to it.
    expect(tsx).not.toMatch(/` — \$\{r\.title\}`/)
  })
})

describe('reviews list — supporting styles exist', () => {
  const css = readFileSync(STYLES_CSS, 'utf8')

  test('styles.css defines .reviews-row__title / __nodeid / __desc', () => {
    expect(css).toMatch(/\.reviews-row__title\s*\{[^}]*font-weight/)
    // nodeId chip just needs a top margin to clear the title; the chip
    // classes handle the rest of the pill styling.
    expect(css).toMatch(/\.reviews-row__nodeid\s*\{[^}]*margin-top/)
    expect(css).toMatch(/\.reviews-row__desc\s*\{[^}]*white-space:\s*pre-wrap/)
  })
})
