// Lock in localized labels for every TaskStatus value, so future status
// additions in @agent-workflow/shared are forced to ship a matching i18n
// entry in both zh-CN and en-US (preventing raw enum strings like
// "awaiting_human" leaking into the UI).

import { describe, expect, test } from 'vitest'
import { TASK_STATUS } from '@agent-workflow/shared'
import i18n, { setLanguage } from '@/i18n'

describe('task status i18n', () => {
  test('every TaskStatus has a non-empty zh-CN + en-US label', () => {
    for (const lang of ['zh-CN', 'en-US'] as const) {
      setLanguage(lang)
      for (const s of TASK_STATUS) {
        const label = i18n.t(`tasks.status.${s}`)
        expect(label, `${lang}:tasks.status.${s}`).not.toBe(`tasks.status.${s}`)
        expect(label.length, `${lang}:tasks.status.${s}`).toBeGreaterThan(0)
      }
    }
    setLanguage('zh-CN')
  })

  test('zh-CN labels for awaiting_* are the user-facing strings, not raw enum', () => {
    setLanguage('zh-CN')
    expect(i18n.t('tasks.status.awaiting_review')).toBe('等待审核')
    expect(i18n.t('tasks.status.awaiting_human')).toBe('等待回答')
    expect(i18n.t('tasks.status.running')).toBe('运行中')
  })
})
