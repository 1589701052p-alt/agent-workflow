// 2026-05-26 UI bug fix: the reject decision dialog used to show
// "提交后将回滚并重跑：(none)" when the workflow's `rerunnableOnReject`
// config was empty. That was a lie — services/review.ts:1315 always
// adds `dv.sourceNodeId` ("direct upstream always rerunnable, regardless
// of config") into the rerun set, and workflow-validator.test.ts:611
// already locks empty as a valid, fully-functional config. The iterate
// branch in the same file (`onIterate`) had the correct
// "(direct upstream)" fallback all along; reject was asymmetric.
//
// This test pins the fix so a future refactor that re-introduces
// "(none)" — or otherwise diverges the reject fallback from iterate's —
// fails immediately. We use a source-level scan (same pattern as
// reviews-detail-readonly-source.test.ts) because the route is too
// heavy to mount under JSDOM.

import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTE_TSX = resolve(__dirname, '..', 'src', 'routes', 'reviews.detail.tsx')

function src(): string {
  return readFileSync(ROUTE_TSX, 'utf8')
}

describe('reviews.detail.tsx — reject willRerun fallback', () => {
  // The "(direct upstream)" literal moved into the i18n bundle as
  // `reviews.rerunDirectUpstream`; the fallback is now `|| t('reviews.rerunDirectUpstream')`.
  test('onReject falls back to t(reviews.rerunDirectUpstream) when rerunnableOnReject is empty', () => {
    const s = src()
    expect(s).toMatch(
      /detail\.data\.rerunnableOnReject\.join\(\s*',\s*'\s*\)\s*\|\|\s*t\('reviews\.rerunDirectUpstream'\)/,
    )
  })

  test('onReject no longer uses the misleading "(none)" fallback', () => {
    const s = src()
    expect(s).not.toMatch(/rerunnableOnReject\.join\(\s*',\s*'\s*\)\s*\|\|\s*'\(none\)'/)
  })

  test('onIterate keeps its t(reviews.rerunDirectUpstream) fallback (symmetry guard)', () => {
    const s = src()
    expect(s).toMatch(
      /detail\.data\.rerunnableOnIterate\.join\(\s*',\s*'\s*\)\s*\|\|\s*t\('reviews\.rerunDirectUpstream'\)/,
    )
  })
})
