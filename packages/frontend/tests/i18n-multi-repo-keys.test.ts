// LOCKS: RFC-066 PR-C — i18n keys for the multi-repo launcher + task detail
// header are present and non-empty in BOTH locales. The global
// `i18n-keys-symmetry.test.ts` already enforces zh ⇄ en union equality;
// this file is the explicit list of keys the launcher / detail wires up.

import { describe, expect, test } from 'vitest'
import { enUS as en } from '@/i18n/en-US'
import { zhCN as zh } from '@/i18n/zh-CN'

const KEYS_TO_CHECK: ReadonlyArray<string> = [
  'launch.repoSource.add',
  'launch.repoSource.remove',
  'launch.repoSource.previewDirName',
  'launch.repoSource.maxReached',
  'launch.repoSource.multiRepoBlocked.wrapper-git',
  'launch.repoSource.multiRepoBlocked.upload',
  'tasks.multiRepoSummary',
]

function deep(obj: unknown, path: string): string | undefined {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return typeof cur === 'string' ? cur : undefined
}

describe('RFC-066 — i18n keys are present and non-empty in both locales', () => {
  for (const key of KEYS_TO_CHECK) {
    test(`en-US: ${key} is non-empty`, () => {
      const v = deep(en, key)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
    test(`zh-CN: ${key} is non-empty`, () => {
      const v = deep(zh, key)
      expect(typeof v).toBe('string')
      expect((v ?? '').length).toBeGreaterThan(0)
    })
  }

  // Placeholder substitution sanity — confirms the values use {{name}} /
  // {{max}} / {{count}} for the keys that take args. Mismatched placeholder
  // would let the UI render literal `{{name}}` text.
  test('previewDirName carries {{name}} placeholder in both locales', () => {
    expect(deep(en, 'launch.repoSource.previewDirName') ?? '').toContain('{{name}}')
    expect(deep(zh, 'launch.repoSource.previewDirName') ?? '').toContain('{{name}}')
  })
  test('maxReached carries {{max}} placeholder in both locales', () => {
    expect(deep(en, 'launch.repoSource.maxReached') ?? '').toContain('{{max}}')
    expect(deep(zh, 'launch.repoSource.maxReached') ?? '').toContain('{{max}}')
  })
  test('multiRepoSummary carries {{count}} placeholder in both locales', () => {
    expect(deep(en, 'tasks.multiRepoSummary') ?? '').toContain('{{count}}')
    expect(deep(zh, 'tasks.multiRepoSummary') ?? '').toContain('{{count}}')
  })
})
