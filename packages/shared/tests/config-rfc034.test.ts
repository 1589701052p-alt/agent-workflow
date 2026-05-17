// RFC-034 — ConfigSchema additions for git submodule recursion.
//
// Locks the new fields gitRecurseSubmodules / gitSubmoduleJobs (both optional)
// against the existing DEFAULT_CONFIG / ConfigPatchSchema contract surface.

import { describe, expect, test } from 'bun:test'

import { ConfigPatchSchema, ConfigSchema, DEFAULT_CONFIG } from '../src/schemas/config.js'

describe('RFC-034 ConfigSchema additions', () => {
  test('full ConfigSchema accepts gitRecurseSubmodules + gitSubmoduleJobs', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      gitRecurseSubmodules: 'always',
      gitSubmoduleJobs: 8,
    })
    expect(parsed.gitRecurseSubmodules).toBe('always')
    expect(parsed.gitSubmoduleJobs).toBe(8)
  })

  test('omitted fields stay undefined (backward-compatible default)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.gitRecurseSubmodules).toBeUndefined()
    expect(parsed.gitSubmoduleJobs).toBeUndefined()
  })

  test('rejects unknown gitRecurseSubmodules enum value', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        gitRecurseSubmodules: 'sometimes' as unknown as 'auto',
      }),
    ).toThrow()
  })

  test('rejects gitSubmoduleJobs out of range', () => {
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, gitSubmoduleJobs: 0 })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, gitSubmoduleJobs: 33 })).toThrow()
    expect(() => ConfigSchema.parse({ ...DEFAULT_CONFIG, gitSubmoduleJobs: 2.5 })).toThrow()
  })

  test('ConfigPatchSchema accepts partial submodule patch without $schema_version', () => {
    const parsed = ConfigPatchSchema.parse({
      gitRecurseSubmodules: 'never',
      gitSubmoduleJobs: 1,
    })
    expect(parsed.gitRecurseSubmodules).toBe('never')
    expect(parsed.gitSubmoduleJobs).toBe(1)
  })

  test('ConfigPatchSchema strips $schema_version even when submodule fields present', () => {
    const parsed = ConfigPatchSchema.parse({
      $schema_version: 1,
      gitRecurseSubmodules: 'auto',
    } as never)
    expect('$schema_version' in parsed).toBe(false)
    expect(parsed.gitRecurseSubmodules).toBe('auto')
  })
})
