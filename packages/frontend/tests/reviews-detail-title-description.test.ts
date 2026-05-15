// Locks in the Review detail page header rendering of title + description
// from the summary (sourced from workflowSnapshot in
// services/review.ts:listReviewSummaries).
//
// User reported "评审页面应该显示评审标题和评审说明，不能只放评审节点ID" —
// the h1 now leads with the title (falling back to the nodeId only when
// title is empty / equals the nodeId), the nodeId becomes a muted subline
// for debug-ability, and the description shows as a page hint paragraph.
//
// Source-text assertions only (per CLAUDE.md §Test-with-every-change "源
// 代码层文本断言"): reviews.detail.tsx renders inside a TanStack Router
// `createRoute` and depends on Route.useParams(); rendering it in JSDOM
// requires the full RouterProvider stack which is out of scope for this
// fix. JSX-shape pinning catches regressions cheaply.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const REVIEWS_DETAIL_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

describe('reviews detail header — title + description', () => {
  const tsx = readFileSync(REVIEWS_DETAIL_TSX, 'utf8')

  test('derives hasTitle from summary.title vs reviewNodeId', () => {
    expect(tsx).toMatch(
      /const hasTitle =[\s\S]*?data\.summary\.title !== ''[\s\S]*?data\.summary\.title !== data\.summary\.reviewNodeId/,
    )
  })

  test('h1 shows summary.title when hasTitle, else falls back to <code>{reviewNodeId}</code>', () => {
    expect(tsx).toMatch(
      /hasTitle \? data\.summary\.title : <code>\{data\.summary\.reviewNodeId\}<\/code>/,
    )
  })

  test('renders muted nodeId subline only when hasTitle is true', () => {
    expect(tsx).toMatch(/\{hasTitle && \([\s\S]*?<code>\{data\.summary\.reviewNodeId\}<\/code>/)
  })

  test('renders summary.description as a page-hint paragraph when non-empty', () => {
    expect(tsx).toMatch(/data\.summary\.description !== ''/)
    expect(tsx).toMatch(
      /className="page__hint review-detail__description">\{data\.summary\.description\}/,
    )
  })

  test('keeps the existing reviews.detailHint paragraph (iteration + decision)', () => {
    // Regression guard: the description block must not replace the
    // iteration / decision hint, only sit above it.
    expect(tsx).toMatch(/t\('reviews\.detailHint'/)
  })

  test('does NOT render the legacy h1 "{workflowName} / <code>{reviewNodeId}</code>" without title support', () => {
    // Old shape unconditionally code-wrapped reviewNodeId in the h1 with
    // no title path. The new shape always goes through the hasTitle
    // ternary; lock that out.
    expect(tsx).not.toMatch(
      /<h1>\s*\{data\.summary\.workflowName\} \/ <code>\{data\.summary\.reviewNodeId\}<\/code>/,
    )
  })
})
