// RFC-066 PR-C — pure-function coverage for the body builders that emit
// the v1 (legacy single-repo) vs v2 (multi-repo) launch shapes. Locks the
// wire contract:
//   - length 1 of `repos` semantically equivalent to legacy single-repo body
//   - length > 1 emits the v2 `repos: [...]` shape
//   - empty body never carries `fetchBeforeLaunch` unless ANY path-mode row
//     opted in (RFC-068 wiring stays the same)
//   - git identity helpers carry through the same pair-check semantics

import { describe, expect, test } from 'vitest'
import {
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  computePreviewDirNames,
  defaultRepoSource,
  type RepoSource,
} from '@/lib/launch-repo-source'

describe('buildLaunchBodyMultiRepo (RFC-066)', () => {
  // F7: 1 path-mode row in v2 shape parses to repos:[{...}], NOT legacy
  // top-level repoPath. Confirms the byte-distinct envelope.
  test('F7 single-entry v2 emits `repos:[...]` (NOT top-level repoPath)', () => {
    const repos: RepoSource[] = [{ kind: 'path', repoPath: '/tmp/r', baseBranch: 'main' }]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect(body.repos).toEqual([{ repoPath: '/tmp/r', baseBranch: 'main' }])
    // The launch route ROUTES via buildLaunchBody (legacy) for length 1,
    // but builders themselves remain orthogonal; v2 wins when explicitly
    // called.
    expect('repoPath' in body).toBe(false)
  })

  // F8: 2 path-mode rows → repos:[{...},{...}], legacy fields absent.
  test('F8 multi-entry v2 emits `repos:[{}, {}]` with no legacy top-level fields', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/tmp/a', baseBranch: 'main' },
      { kind: 'path', repoPath: '/tmp/b', baseBranch: 'develop' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect(body.repos).toEqual([
      { repoPath: '/tmp/a', baseBranch: 'main' },
      { repoPath: '/tmp/b', baseBranch: 'develop' },
    ])
    expect('repoPath' in body).toBe(false)
    expect('repoUrl' in body).toBe(false)
    expect('baseBranch' in body).toBe(false)
  })

  test('F8b mixed path + url entries — each row carries its own keys', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/tmp/a', baseBranch: 'main' },
      { kind: 'url', repoUrl: 'git@github.com:foo/bar.git', ref: 'develop' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect(body.repos).toEqual([
      { repoPath: '/tmp/a', baseBranch: 'main' },
      { repoUrl: 'git@github.com:foo/bar.git', ref: 'develop' },
    ])
  })

  test('F8c url row with empty ref drops the `ref` key (mirrors single-repo helper)', () => {
    const repos: RepoSource[] = [
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '   ' },
      { kind: 'url', repoUrl: 'git@h:o/r2.git', ref: '' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    const out = body.repos as Array<Record<string, unknown>>
    expect('ref' in out[0]!).toBe(false)
    expect('ref' in out[1]!).toBe(false)
  })

  // RFC-068 carry-through: any path-mode row opting in → top-level
  // fetchBeforeLaunch=true. URL-only / all-off → key omitted.
  test('F8d any path-mode row opted into fetchBeforeLaunch → top-level true', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/tmp/a', baseBranch: 'main' },
      { kind: 'path', repoPath: '/tmp/b', baseBranch: 'main', fetchBeforeLaunch: true },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect(body.fetchBeforeLaunch).toBe(true)
  })

  test('F8e no row opted in → fetchBeforeLaunch key omitted', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/tmp/a', baseBranch: 'main' },
      { kind: 'path', repoPath: '/tmp/b', baseBranch: 'main', fetchBeforeLaunch: false },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
    })
    expect('fetchBeforeLaunch' in body).toBe(false)
  })

  // RFC-067: identity pair-check echoes single-repo helper.
  test('F8f both git identity fields set → carried through verbatim', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/tmp/a', baseBranch: 'main' },
      { kind: 'path', repoPath: '/tmp/b', baseBranch: 'main' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
      gitUserName: 'AI Bot',
      gitUserEmail: 'bot@workflow.local',
    })
    expect(body.gitUserName).toBe('AI Bot')
    expect(body.gitUserEmail).toBe('bot@workflow.local')
  })

  test('F8g half-set git identity → both keys dropped (defense in depth)', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/tmp/a', baseBranch: 'main' },
      { kind: 'path', repoPath: '/tmp/b', baseBranch: 'main' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, {
      workflowId: 'wf-1',
      name: 't',
      inputs: {},
      gitUserName: 'Lonely',
      gitUserEmail: '',
    })
    expect('gitUserName' in body).toBe(false)
    expect('gitUserEmail' in body).toBe(false)
  })
})

describe('buildLaunchBody RFC-066 single-repo byte-baseline (regression lock)', () => {
  // F13-style guard: pre-RFC-066 callers still get the same wire shape.
  test('legacy path body unchanged', () => {
    const body = buildLaunchBody(
      { kind: 'path', repoPath: '/tmp/r', baseBranch: 'main' },
      { workflowId: 'wf-1', name: 't', inputs: { k: 'v' } },
    )
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 't',
      repoPath: '/tmp/r',
      baseBranch: 'main',
      inputs: { k: 'v' },
    })
    expect('repos' in body).toBe(false)
  })

  test('legacy url body unchanged', () => {
    const body = buildLaunchBody(
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'feature/x' },
      { workflowId: 'wf-1', name: 't', inputs: {} },
    )
    expect(body).toEqual({
      workflowId: 'wf-1',
      name: 't',
      repoUrl: 'git@h:o/r.git',
      inputs: {},
      ref: 'feature/x',
    })
    expect('repos' in body).toBe(false)
  })
})

describe('computePreviewDirNames (RFC-066)', () => {
  // F6: basename collision resolution mirrors backend resolveMultiRepoDirName.
  test('F6 same basename in path mode → -2 / -3 suffix', () => {
    const names = computePreviewDirNames([
      { kind: 'path', repoPath: '/a/utils', baseBranch: 'main' },
      { kind: 'path', repoPath: '/b/utils', baseBranch: 'main' },
      { kind: 'path', repoPath: '/c/utils', baseBranch: 'main' },
    ])
    expect(names).toEqual(['utils', 'utils-2', 'utils-3'])
  })

  test('F6b length 1 always returns [""] (no preview in single-repo mode)', () => {
    const names = computePreviewDirNames([
      { kind: 'path', repoPath: '/a/utils', baseBranch: 'main' },
    ])
    expect(names).toEqual([''])
  })

  test('F6c URL mode basename strips .git suffix', () => {
    const names = computePreviewDirNames([
      { kind: 'url', repoUrl: 'git@github.com:org/repo-a.git', ref: '' },
      { kind: 'url', repoUrl: 'https://github.com/org/repo-b', ref: '' },
    ])
    expect(names).toEqual(['repo-a', 'repo-b'])
  })

  test('F6d empty row → empty preview slot (UI suppresses chip)', () => {
    const names = computePreviewDirNames([
      { kind: 'path', repoPath: '/a/utils', baseBranch: 'main' },
      defaultRepoSource(),
    ])
    expect(names).toEqual(['utils', ''])
  })
})
