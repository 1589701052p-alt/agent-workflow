// RFC-024 T6 — pure-function tests for the launcher's two-mode Repo source
// helpers. Locks `buildLaunchBody` body shape, `validateRepoUrl` outcomes,
// and the source-level wiring in workflows.launch.tsx + RepoSourceTabs.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { CachedRepo } from '@agent-workflow/shared'
import {
  buildLaunchBody,
  buildLaunchFormDataV2,
  resolveUrlRepoPath,
  validateRepoUrl,
  type RepoSource,
} from '@/lib/launch-repo-source'

describe('buildLaunchBody (RFC-024)', () => {
  test('path mode emits workflowId/repoPath/baseBranch/inputs', () => {
    const src: RepoSource = { kind: 'path', repoPath: '/tmp/repo', baseBranch: 'main' }
    const body = buildLaunchBody(src, {
      workflowId: 'wf-1',
      name: 'fixture-task',
      inputs: { topic: 'orders' },
    })
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoPath: '/tmp/repo',
      baseBranch: 'main',
      inputs: { topic: 'orders' },
    })
    expect('repoUrl' in body).toBe(false)
    expect('ref' in body).toBe(false)
  })

  test('url mode emits workflowId/repoUrl/inputs (no baseBranch)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@github.com:foo/bar.git', ref: '' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 'fixture-task', inputs: {} })
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 'fixture-task',
      repoUrl: 'git@github.com:foo/bar.git',
      inputs: {},
    })
    expect('baseBranch' in body).toBe(false)
    expect('ref' in body).toBe(false)
  })

  test('url mode keeps non-empty ref (trimmed)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '  feature/x  ' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 'fixture-task', inputs: {} })
    expect(body.ref).toBe('feature/x')
  })
})

describe('validateRepoUrl (RFC-024)', () => {
  test('empty → empty', () => {
    expect(validateRepoUrl('')).toBe('empty')
    expect(validateRepoUrl('   ')).toBe('empty')
  })

  test('plausible SSH / HTTPS → null', () => {
    expect(validateRepoUrl('git@github.com:foo/bar.git')).toBeNull()
    expect(validateRepoUrl('https://github.com/foo/bar.git')).toBeNull()
    expect(validateRepoUrl('ssh://git@host/x/y')).toBeNull()
  })

  test('malformed → invalid', () => {
    expect(validateRepoUrl('/some/path')).toBe('invalid')
    expect(validateRepoUrl('not a url')).toBe('invalid')
  })
})

describe('buildLaunchFormDataV2 (RFC-024)', () => {
  test('embeds JSON payload for URL mode + files for each upload key', async () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '' }
    const f1 = new File(['hello'], 'a.txt', { type: 'text/plain' })
    const f2 = new File(['world'], 'b.txt', { type: 'text/plain' })
    const fd = buildLaunchFormDataV2(
      src,
      { workflowId: 'wf-1', name: 'fixture-task', inputs: { topic: 'orders' } },
      { docs: [f1, f2] },
    )
    // payload field is a Blob with the JSON body.
    const payloadBlob = fd.get('payload') as Blob
    expect(payloadBlob).toBeInstanceOf(Blob)
    const txt = await payloadBlob.text()
    const parsed = JSON.parse(txt)
    expect(parsed.repoUrl).toBe('git@h:o/r.git')
    expect('repoPath' in parsed).toBe(false)
    // Files appear under files[<key>][].
    const files = fd.getAll('files[docs][]')
    expect(files.length).toBe(2)
  })
})

describe('workflows.launch.tsx wiring (RFC-024 source-level)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
    'utf-8',
  )

  test('imports RepoSourceList (RFC-066: multi-repo container; back-compat shim RepoSourceTabs still exists)', () => {
    // The launch route now renders the multi-repo container directly.
    // The old `RepoSourceTabs` is a thin back-compat shim around
    // `RepoSourceRow` (see launch-repo-source-list.test.tsx + repo-source-
    // tabs-field-parity.test.ts for the full coverage of both surfaces).
    expect(SRC).toContain('RepoSourceList')
  })

  test('uses buildLaunchBody (not the old inline payload)', () => {
    expect(SRC).toContain('buildLaunchBody')
    // The legacy inline `payload = { workflowId: id, repoPath, baseBranch, inputs }` block is gone.
    expect(SRC).not.toMatch(/payload = \{ workflowId: id, repoPath, baseBranch, inputs \}/)
  })

  test('canSubmit gate considers both source modes via validateRepoUrl', () => {
    expect(SRC).toContain('validateRepoUrl')
  })

  test('renders the cloning hint while POST is pending in URL mode', () => {
    expect(SRC).toContain('launch.repoSource.cloningHint')
  })
})

// -----------------------------------------------------------------------------
// RFC-068 — fetchBeforeLaunch wiring + path-mode opt-in switch
// -----------------------------------------------------------------------------

describe('buildLaunchBody fetchBeforeLaunch (RFC-068)', () => {
  test('path mode + fetchBeforeLaunch=true → body includes fetchBeforeLaunch=true', () => {
    const src: RepoSource = {
      kind: 'path',
      repoPath: '/tmp/r',
      baseBranch: 'main',
      fetchBeforeLaunch: true,
    }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 't', inputs: {} })
    expect(body.fetchBeforeLaunch).toBe(true)
  })

  test('path mode + fetchBeforeLaunch=false → body omits fetchBeforeLaunch (legacy bytes)', () => {
    const src: RepoSource = {
      kind: 'path',
      repoPath: '/tmp/r',
      baseBranch: 'main',
      fetchBeforeLaunch: false,
    }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 't', inputs: {} })
    expect('fetchBeforeLaunch' in body).toBe(false)
  })

  test('path mode + fetchBeforeLaunch undefined → body omits fetchBeforeLaunch', () => {
    const src: RepoSource = { kind: 'path', repoPath: '/tmp/r', baseBranch: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 't', inputs: {} })
    expect('fetchBeforeLaunch' in body).toBe(false)
  })

  test('url mode → body never carries fetchBeforeLaunch (auto FF is server-side)', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf-1', name: 't', inputs: {} })
    expect('fetchBeforeLaunch' in body).toBe(false)
  })
})

describe('RepoSourceTabs RFC-068 source-level wiring', () => {
  // RFC-066 PR-C: the path/url switching body moved into RepoSourceRow.tsx
  // when the multi-repo container was carved out. RepoSourceTabs.tsx is
  // now a thin back-compat wrapper that delegates to RepoSourceRow; the
  // RFC-068 wiring (Switch import, localStorage key, switch labels,
  // url-auto-sync hint, fetchBeforeLaunch default) lives in the row file.
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'components', 'launch', 'RepoSourceRow.tsx'),
    'utf-8',
  )

  test('imports Switch (path-mode opt-in toggle uses it)', () => {
    expect(SRC).toMatch(/import\s*\{[^}]*\bSwitch\b[^}]*\}\s*from\s*['"]@\/components\/Form['"]/)
  })

  test('persists fetchBeforeLaunch to localStorage', () => {
    expect(SRC).toContain('agent-workflow.launcher.pathFetch')
    expect(SRC).toContain('localStorage')
  })

  test('renders path-mode switch label key from i18n', () => {
    expect(SRC).toContain('launch.pathFetch.switchLabel')
    expect(SRC).toContain('launch.pathFetch.switchHint')
  })

  test('renders URL-mode auto-sync hint', () => {
    expect(SRC).toContain('launch.repoSource.urlAutoSync')
  })

  test('source switch defaults path mode fetchBeforeLaunch from loaded pref', () => {
    expect(SRC).toContain('loadFetchBeforeLaunchPref')
  })
})

// -----------------------------------------------------------------------------
// RFC-110 — resolveUrlRepoPath: url-mode pickers enumerate the matched cached
// clone; cross-protocol / miss / unparseable → '' (text fallback upstream).
// -----------------------------------------------------------------------------

function cachedRepo(url: string, localPath: string): CachedRepo {
  return {
    id: `id-${localPath}`,
    url,
    urlRedacted: url,
    localPath,
    defaultBranch: 'main',
    lastFetchedAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    referencingTaskCount: 0,
    hasSubmodules: null,
    lastSubmoduleSyncOk: null,
    lastSubmoduleSyncError: null,
  }
}

describe('resolveUrlRepoPath (RFC-110)', () => {
  test('path mode → source.repoPath verbatim (incl. empty)', () => {
    expect(resolveUrlRepoPath({ kind: 'path', repoPath: '/local/x', baseBranch: 'main' }, [])).toBe(
      '/local/x',
    )
    expect(resolveUrlRepoPath({ kind: 'path', repoPath: '', baseBranch: '' }, [])).toBe('')
  })

  test('url mode hit → cached localPath, robust to .git / trailing slash', () => {
    const list = [cachedRepo('https://github.com/foo/bar.git', '/cache/bar')]
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar', ref: '' }, list),
    ).toBe('/cache/bar')
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar/', ref: '' }, list),
    ).toBe('/cache/bar')
    expect(
      resolveUrlRepoPath(
        { kind: 'url', repoUrl: 'https://user:tok@github.com/foo/bar.git', ref: '' },
        list,
      ),
    ).toBe('/cache/bar')
  })

  test('url mode cross-protocol → no match (SSH cache, HTTPS typed)', () => {
    const list = [cachedRepo('git@github.com:foo/bar.git', '/cache/ssh')]
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar', ref: '' }, list),
    ).toBe('')
  })

  test('url mode miss / unparseable / empty cache → ""', () => {
    const list = [cachedRepo('https://github.com/foo/bar', '/cache/bar')]
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/other', ref: '' }, list),
    ).toBe('')
    expect(resolveUrlRepoPath({ kind: 'url', repoUrl: 'not a url', ref: '' }, list)).toBe('')
    expect(
      resolveUrlRepoPath({ kind: 'url', repoUrl: 'https://github.com/foo/bar', ref: '' }, []),
    ).toBe('')
  })
})

describe('workflows.launch.tsx wiring (RFC-110 source-level)', () => {
  const SRC = readFileSync(
    resolve(import.meta.dirname, '..', 'src', 'routes', 'workflows.launch.tsx'),
    'utf-8',
  )

  test('resolves the picker repoPath via resolveUrlRepoPath (not the old url-clearing hardcode)', () => {
    expect(SRC).toContain('resolveUrlRepoPath')
    // The old `primarySource.kind === 'path' ? primarySource.repoPath : ''`
    // hardcode that broke file/git pickers in url mode must be gone.
    expect(SRC).not.toMatch(
      /repoPath=\{primarySource\.kind === 'path' \? primarySource\.repoPath : ''\}/,
    )
  })

  test('threads sourceKind into the dynamic input so pickers can fall back', () => {
    expect(SRC).toContain('sourceKind={primarySource.kind}')
  })

  test('queries cached-repos so url-mode pickers can resolve a localPath', () => {
    expect(SRC).toContain("queryKey: ['cached-repos']")
  })
})
