// RFC-034 — CachedRepoSchema / RefreshCachedRepoResponseSchema additions
// for submodule recursion telemetry.
//
// Locks: hasSubmodules / lastSubmoduleSyncOk / lastSubmoduleSyncError are
// nullable on cached_repos rows (legacy rows pre-RFC-034 serialize as null)
// and refresh responses carry submoduleSyncOk / submoduleSyncError /
// hasSubmodules as non-nullable booleans + nullable error string.

import { describe, expect, test } from 'bun:test'

import { CachedRepoSchema, RefreshCachedRepoResponseSchema } from '../src/schemas/cachedRepo.js'

const baseRow = {
  id: 'cr_01',
  url: 'git@github.com:foo/bar.git',
  urlRedacted: 'git@github.com:foo/bar.git',
  localPath: '/tmp/foo',
  defaultBranch: 'main',
  lastFetchedAt: '2026-05-17T00:00:00.000Z',
  createdAt: '2026-05-17T00:00:00.000Z',
  referencingTaskCount: 0,
}

describe('RFC-034 CachedRepoSchema additions', () => {
  test('legacy row (all three submodule columns null) parses', () => {
    const parsed = CachedRepoSchema.parse({
      ...baseRow,
      hasSubmodules: null,
      lastSubmoduleSyncOk: null,
      lastSubmoduleSyncError: null,
    })
    expect(parsed.hasSubmodules).toBeNull()
    expect(parsed.lastSubmoduleSyncOk).toBeNull()
    expect(parsed.lastSubmoduleSyncError).toBeNull()
  })

  test('row with success telemetry parses', () => {
    const parsed = CachedRepoSchema.parse({
      ...baseRow,
      hasSubmodules: true,
      lastSubmoduleSyncOk: true,
      lastSubmoduleSyncError: null,
    })
    expect(parsed.hasSubmodules).toBe(true)
    expect(parsed.lastSubmoduleSyncOk).toBe(true)
  })

  test('row with failure stderr parses', () => {
    const parsed = CachedRepoSchema.parse({
      ...baseRow,
      hasSubmodules: true,
      lastSubmoduleSyncOk: false,
      lastSubmoduleSyncError: 'fatal: could not read Username for https://***@host/sub.git',
    })
    expect(parsed.lastSubmoduleSyncOk).toBe(false)
    expect(parsed.lastSubmoduleSyncError).toContain('***')
  })

  test('rejects row missing the three RFC-034 columns', () => {
    expect(() => CachedRepoSchema.parse({ ...baseRow })).toThrow()
  })
})

describe('RFC-034 RefreshCachedRepoResponseSchema additions', () => {
  test('happy refresh response parses', () => {
    const parsed = RefreshCachedRepoResponseSchema.parse({
      item: {
        ...baseRow,
        hasSubmodules: true,
        lastSubmoduleSyncOk: true,
        lastSubmoduleSyncError: null,
      },
      fetchOk: true,
      fetchError: null,
      submoduleSyncOk: true,
      submoduleSyncError: null,
      hasSubmodules: true,
    })
    expect(parsed.submoduleSyncOk).toBe(true)
    expect(parsed.hasSubmodules).toBe(true)
  })

  test('submodule failure still treats fetch as ok', () => {
    const parsed = RefreshCachedRepoResponseSchema.parse({
      item: {
        ...baseRow,
        hasSubmodules: true,
        lastSubmoduleSyncOk: false,
        lastSubmoduleSyncError: 'permission denied',
      },
      fetchOk: true,
      fetchError: null,
      submoduleSyncOk: false,
      submoduleSyncError: 'permission denied',
      hasSubmodules: true,
    })
    expect(parsed.fetchOk).toBe(true)
    expect(parsed.submoduleSyncOk).toBe(false)
    expect(parsed.submoduleSyncError).toBe('permission denied')
  })
})
