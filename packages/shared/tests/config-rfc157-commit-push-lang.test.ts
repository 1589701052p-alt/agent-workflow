// RFC-157 — ConfigSchema additions for the built-in commit agent output language.
//
// Mirrors config-rfc050 (memoryDistillLang). Locks `commitPushLang` (optional,
// two-value enum) against ConfigSchema / ConfigPatchSchema / DEFAULT_CONFIG.
// Runtime fallback to 'en-US' lives in the scheduler / prompt layer, not here.
//
// The PATCH-only `null` widening is the load-bearing part (Codex design-gate
// P2-1): the "System agents" tab's language <Select> sends `null` for "Default"
// so mergePatch DELETES a saved language (undefined would be dropped by
// JSON.stringify → treated as "no change" → zh-CN could never revert to Default).
// The same widening covers `memoryDistillLang` (its select gets the same fix so
// the two language pickers stay consistent). The base ConfigSchema must still
// REJECT null — null is patch-only = delete, never a persisted value.

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

describe('RFC-157 ConfigSchema additions — commitPushLang', () => {
  test('accepts zh-CN', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG, commitPushLang: 'zh-CN' })
    expect(parsed.commitPushLang).toBe('zh-CN')
  })

  test('accepts en-US', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG, commitPushLang: 'en-US' })
    expect(parsed.commitPushLang).toBe('en-US')
  })

  test('omitted field stays undefined (backward-compatible; runtime fallback en-US)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.commitPushLang).toBeUndefined()
  })

  test('DEFAULT_CONFIG does NOT set a default value (scheduler layer falls back)', () => {
    // Keeping it unset means existing config.json files need no migration, and
    // absence is semantically identical to 'en-US' (RFC-075 English baseline).
    expect(DEFAULT_CONFIG.commitPushLang).toBeUndefined()
  })

  test('invalid value rejected', () => {
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, commitPushLang: 'ja-JP' })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, commitPushLang: '' })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, commitPushLang: 123 })).toThrow()
  })

  test('base ConfigSchema does NOT accept null (null is patch-only = delete)', () => {
    // On-disk config never holds null for this field; null only means "delete
    // this key" on the PATCH wire. Guards against the nullable widening leaking
    // into the persisted schema.
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, commitPushLang: null })).toThrow()
  })
})

describe('RFC-157 ConfigPatchSchema — commitPushLang / memoryDistillLang nullable in PATCH', () => {
  // Both language fields must accept null so "Default" actually clears a saved
  // value (Codex design-gate P2-1). They stay consistent with each other.
  for (const key of ['commitPushLang', 'memoryDistillLang'] as const) {
    test(`${key}: accepts a value`, () => {
      const parsed = ConfigPatchSchema.parse({ [key]: 'zh-CN' }) as Record<string, unknown>
      expect(parsed[key]).toBe('zh-CN')
    })
    test(`${key}: accepts null (clears the saved language → Default/en-US)`, () => {
      const parsed = ConfigPatchSchema.parse({ [key]: null }) as Record<string, unknown>
      expect(parsed[key]).toBeNull()
    })
    test(`${key}: still rejects an invalid value`, () => {
      expect(() => ConfigPatchSchema.parse({ [key]: 'ja-JP' })).toThrow()
      expect(() => ConfigPatchSchema.parse({ [key]: '' })).toThrow()
    })
  }
})
