// RFC-075 — guard the commit&push runtime knobs on the Settings → Runtime tab.
// Source + i18n grep (the settings route is heavy to mount). A regression that
// dropped a key from the useTabState slice would silently stop persisting it.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const SETTINGS = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'settings.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')

describe('settings.tsx — RFC-075 commit&push config', () => {
  test('persists all three keys in the Runtime tab draft slice', () => {
    expect(SETTINGS).toContain("'commitPushModel'")
    expect(SETTINGS).toContain("'commitPushMaxRepairRetries'")
    expect(SETTINGS).toContain("'commitPushDiffMaxBytes'")
  })
  test('renders the three fields bound to state', () => {
    expect(SETTINGS).toMatch(/state\.commitPushModel/)
    expect(SETTINGS).toMatch(/state\.commitPushMaxRepairRetries/)
    expect(SETTINGS).toMatch(/state\.commitPushDiffMaxBytes/)
    expect(SETTINGS).toContain("t('settingsForm.commitPushModel')")
  })
})

describe('i18n — RFC-075 settings keys present in both locales', () => {
  test('zh-CN', () => {
    expect(ZH).toContain("commitPushModel: '提交&推送模型'")
    expect(ZH).toContain('commitPushMaxRepairRetries:')
    expect(ZH).toContain('commitPushDiffMaxBytes:')
  })
  test('en-US', () => {
    expect(EN).toContain("commitPushModel: 'Commit & push model'")
    expect(EN).toContain('commitPushMaxRepairRetries:')
    expect(EN).toContain('commitPushDiffMaxBytes:')
  })
})
