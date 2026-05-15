// RFC-008 T3 — locks the reviews.detail route → <Prose> migration.
//
// Two regression locks:
//   1. Source-level: reviews.detail.tsx imports `<Prose>` from the prose
//      module and does NOT reference the removed `MarkdownView` component.
//   2. wrapAnchorsInDom — review comment anchor wrapping (used by the
//      bubble layout + scroll-spy) must still locate plain-text inside
//      <Prose>'s DOM. We render <Prose> directly with body text and then
//      run wrapAnchorsInDom to assert the mark element lands.

import { describe, expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Prose } from '@/components/prose/Prose'
import { wrapAnchorsInDom } from '@/lib/review/wrapAnchorsInDom'

describe('reviews.detail uses <Prose>', () => {
  test('source-level: route imports Prose, not MarkdownView', () => {
    const src = readFileSync(resolve(__dirname, '../src/routes/reviews.detail.tsx'), 'utf-8')
    expect(src).toContain("from '@/components/prose/Prose'")
    expect(src).toContain('<Prose')
    expect(src).not.toContain("from '@/components/review/MarkdownView'")
    expect(src).not.toContain('<MarkdownView')
  })

  test('wrapAnchorsInDom can locate plain text in Prose output', () => {
    const md = `Some pre text. The selected phrase appears here. Post text.\n`
    const { container } = render(<Prose body={md} />)
    const root = container.querySelector('.prose')
    expect(root).not.toBeNull()
    wrapAnchorsInDom(root as HTMLElement, [
      { commentId: 'c1', selectedText: 'selected phrase', occurrenceIndex: 1 },
    ])
    const mark = container.querySelector('mark.comment-anchor[data-comment-id="c1"]')
    expect(mark).not.toBeNull()
    expect(mark?.textContent).toBe('selected phrase')
  })
})
