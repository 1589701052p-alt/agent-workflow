// RFC-025: lock zh-CN and en-US bundles to identical key shapes, and assert
// the 6 new language-switch keys are present in both.
//
// Why this regression test exists: every new UI RFC adds i18n keys in both
// locales, and it is easy to forget one side. The symmetry check catches
// "added to zh-CN but not en-US" (or vice versa) before it ships as missing
// labels at runtime.

import { describe, expect, test } from 'vitest'
import { zhCN } from '@/i18n/zh-CN'
import { enUS } from '@/i18n/en-US'

function collectKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return [prefix]
  const out: string[] = []
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const next = prefix === '' ? k : `${prefix}.${k}`
    if (v !== null && typeof v === 'object') {
      out.push(...collectKeys(v, next))
    } else {
      out.push(next)
    }
  }
  return out.sort()
}

describe('RFC-025 i18n key symmetry', () => {
  test('zh-CN and en-US carry the exact same flattened key set', () => {
    const zh = new Set(collectKeys(zhCN))
    const en = new Set(collectKeys(enUS))
    const onlyZh = [...zh].filter((k) => !en.has(k))
    const onlyEn = [...en].filter((k) => !zh.has(k))
    expect(onlyZh).toEqual([])
    expect(onlyEn).toEqual([])
  })

  test('settings.language* keys exist in both bundles', () => {
    expect(zhCN.settings.languageLabel.length).toBeGreaterThan(0)
    expect(zhCN.settings.languageHint.length).toBeGreaterThan(0)
    expect(zhCN.settings.languageZhCN.length).toBeGreaterThan(0)
    expect(zhCN.settings.languageEnUS.length).toBeGreaterThan(0)
    expect(enUS.settings.languageLabel.length).toBeGreaterThan(0)
    expect(enUS.settings.languageHint.length).toBeGreaterThan(0)
    expect(enUS.settings.languageZhCN.length).toBeGreaterThan(0)
    expect(enUS.settings.languageEnUS.length).toBeGreaterThan(0)
  })

  test('sidebar.lang.{zh,en} + sidebar.languageGroupLabel exist in both bundles', () => {
    expect(zhCN.sidebar.languageGroupLabel.length).toBeGreaterThan(0)
    expect(zhCN.sidebar.lang.zh.length).toBeGreaterThan(0)
    expect(zhCN.sidebar.lang.en.length).toBeGreaterThan(0)
    expect(enUS.sidebar.languageGroupLabel.length).toBeGreaterThan(0)
    expect(enUS.sidebar.lang.zh.length).toBeGreaterThan(0)
    expect(enUS.sidebar.lang.en.length).toBeGreaterThan(0)
  })
})
