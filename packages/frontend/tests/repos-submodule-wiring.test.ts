// RFC-034 T9/T10 source-level wiring locks:
//   - repos.tsx imports + renders <SubmoduleBadge />
//   - shared schema exposes gitRecurseSubmodules / gitSubmoduleJobs +
//     hasSubmodules / lastSubmoduleSyncOk / lastSubmoduleSyncError so the UI
//     reads stable field names
//   - i18n locales carry the four submodule.* keys symmetrically

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const REPOS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'routes', 'repos.tsx'),
  'utf-8',
)
const BADGE_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'src', 'components', 'repos', 'SubmoduleBadge.tsx'),
  'utf-8',
)
const ZH = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'zh-CN.ts'), 'utf-8')
const EN = readFileSync(resolve(import.meta.dirname, '..', 'src', 'i18n', 'en-US.ts'), 'utf-8')
const CONFIG_SRC = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'shared', 'src', 'schemas', 'config.ts'),
  'utf-8',
)
const CACHED_REPO_SRC = readFileSync(
  resolve(import.meta.dirname, '..', '..', 'shared', 'src', 'schemas', 'cachedRepo.ts'),
  'utf-8',
)

describe('RFC-034 wiring locks', () => {
  test('repos.tsx imports + renders SubmoduleBadge', () => {
    expect(REPOS_SRC).toContain('SubmoduleBadge')
    expect(REPOS_SRC).toContain('hasSubmodules={item.hasSubmodules}')
  })

  test('SubmoduleBadge component file exists and exposes data-testids', () => {
    expect(BADGE_SRC).toContain('submodule-badge-ok')
    expect(BADGE_SRC).toContain('submodule-badge-error')
  })

  test('config schema declares gitRecurseSubmodules + gitSubmoduleJobs', () => {
    expect(CONFIG_SRC).toContain('gitRecurseSubmodules')
    expect(CONFIG_SRC).toContain('gitSubmoduleJobs')
    // mode enum stays explicit (no implicit defaults bleeding into other tabs).
    expect(CONFIG_SRC).toMatch(/['"]auto['"]/)
    expect(CONFIG_SRC).toMatch(/['"]always['"]/)
    expect(CONFIG_SRC).toMatch(/['"]never['"]/)
  })

  test('cachedRepo schema declares the three submodule columns', () => {
    expect(CACHED_REPO_SRC).toContain('hasSubmodules')
    expect(CACHED_REPO_SRC).toContain('lastSubmoduleSyncOk')
    expect(CACHED_REPO_SRC).toContain('lastSubmoduleSyncError')
  })

  test('zh + en carry submodule.{labelOk,labelError,titleOk,errorFallback}', () => {
    for (const src of [ZH, EN]) {
      expect(src).toContain('submodule:')
      expect(src).toContain('labelOk:')
      expect(src).toContain('labelError:')
      expect(src).toContain('titleOk:')
      expect(src).toContain('errorFallback:')
    }
  })
})
