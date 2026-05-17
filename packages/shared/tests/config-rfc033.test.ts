// RFC-033 — ConfigSchema additions for the batch-import driver. Both fields
// are optional so existing config files remain valid.

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config'

describe('RFC-033 ConfigSchema additions', () => {
  test('accepts repoBatchImportConcurrency + repoBatchImportRetentionMs', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      repoBatchImportConcurrency: 5,
      repoBatchImportRetentionMs: 1800000,
    })
    expect(parsed.repoBatchImportConcurrency).toBe(5)
    expect(parsed.repoBatchImportRetentionMs).toBe(1800000)
  })

  test('omitted fields stay undefined (backward-compatible default)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.repoBatchImportConcurrency).toBeUndefined()
    expect(parsed.repoBatchImportRetentionMs).toBeUndefined()
  })

  test('rejects out-of-range concurrency (0 or 9)', () => {
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, repoBatchImportConcurrency: 0 })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, repoBatchImportConcurrency: 9 })).toThrow()
  })

  test('ConfigPatchSchema permits partial update with these fields', () => {
    const parsed = ConfigPatchSchema.parse({ repoBatchImportConcurrency: 2 })
    expect(parsed.repoBatchImportConcurrency).toBe(2)
  })
})
