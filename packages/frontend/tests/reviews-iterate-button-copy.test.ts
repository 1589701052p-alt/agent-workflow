// Locks in the June 2026 copy change for the markdown review page's third
// decision button. It used to read the bare verb "迭代" / "Iterate", which
// did not convey *what* it does — re-run the upstream node so the agent
// revises the document based on the submitted review comments. Per user
// feedback the zh-CN label now reads "根据评审意见修改" ("revise based on
// review comments"); the en-US label is kept in parity as "Revise per
// comments".
//
// Both single-doc (reviews.detail.tsx) and multi-doc (MultiDocReviewView.tsx)
// render this button via `t('reviews.iterateButton')`, so locking the value
// here guards both surfaces. A value-lock is the right regression guard for a
// copy change (per CLAUDE.md §Test-with-every-change): if anyone reverts it
// to "迭代" / "Iterate" this goes red and points at the intent.

import { describe, expect, test } from 'vitest'
import { zhCN } from '@/i18n/zh-CN'
import { enUS } from '@/i18n/en-US'

describe('reviews iterate button copy', () => {
  test('zh-CN button explains the action instead of the bare verb 迭代', () => {
    expect(zhCN.reviews.iterateButton).toBe('根据评审意见修改')
    expect(zhCN.reviews.iterateButton).not.toBe('迭代')
  })

  test('en-US button stays in parity with a comment-driven label', () => {
    expect(enUS.reviews.iterateButton).toBe('Revise per comments')
    expect(enUS.reviews.iterateButton).not.toBe('Iterate')
  })
})
