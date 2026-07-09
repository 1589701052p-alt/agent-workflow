// RFC-159 (edit-config) — `bodyToRepoSources` reverses a stored StartTask launch
// body back into the launcher's `RepoSource[]` so the scheduled-task edit-config
// form can pre-fill the repo picker. This is the assertable seam behind the launch
// form's edit mode; if it goes red the edit form will mis-seed the repo rows.
//
// The round-trip cases (forward via buildLaunchBody* then inverse) are the load
// bearing guard: a schedule's payload was ORIGINALLY built by those helpers, so
// inverse(forward(x)) must equal x for the repo shape.

import { describe, expect, test } from 'vitest'
import {
  bodyToRepoSources,
  buildLaunchBody,
  buildLaunchBodyMultiRepo,
  defaultRepoSource,
  type RepoSource,
} from '@/lib/launch-repo-source'

describe('bodyToRepoSources — legacy single-repo bodies', () => {
  test('path body → one path source', () => {
    expect(bodyToRepoSources({ repoPath: '/r', baseBranch: 'main' })).toEqual([
      { kind: 'path', repoPath: '/r', baseBranch: 'main' },
    ])
  })

  test('path body missing baseBranch → empty baseBranch (never undefined)', () => {
    expect(bodyToRepoSources({ repoPath: '/r' })).toEqual([
      { kind: 'path', repoPath: '/r', baseBranch: '' },
    ])
  })

  test('url body → one url source, ref defaults to empty', () => {
    expect(bodyToRepoSources({ repoUrl: 'git@h:o/r.git' })).toEqual([
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: '' },
    ])
  })

  test('url body with ref preserves ref', () => {
    expect(bodyToRepoSources({ repoUrl: 'git@h:o/r.git', ref: 'v1.2' })).toEqual([
      { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'v1.2' },
    ])
  })
})

describe('bodyToRepoSources — multi-repo bodies', () => {
  test('repos[] → one source per entry, url wins the per-entry mutex', () => {
    expect(
      bodyToRepoSources({
        repos: [
          { repoPath: '/a', baseBranch: 'main' },
          { repoUrl: 'git@h:o/b.git', ref: 'dev' },
          { repoUrl: 'git@h:o/c.git' },
        ],
      }),
    ).toEqual([
      { kind: 'path', repoPath: '/a', baseBranch: 'main' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: 'dev' },
      { kind: 'url', repoUrl: 'git@h:o/c.git', ref: '' },
    ])
  })
})

describe('bodyToRepoSources — fetchBeforeLaunch top-level flag', () => {
  test('single path re-applies the flag', () => {
    expect(
      bodyToRepoSources({ repoPath: '/r', baseBranch: 'main', fetchBeforeLaunch: true }),
    ).toEqual([{ kind: 'path', repoPath: '/r', baseBranch: 'main', fetchBeforeLaunch: true }])
  })

  test('multi-repo re-applies the flag to path rows only, never url rows', () => {
    const out = bodyToRepoSources({
      fetchBeforeLaunch: true,
      repos: [{ repoPath: '/a', baseBranch: 'main' }, { repoUrl: 'git@h:o/b.git' }],
    })
    expect(out[0]).toEqual({
      kind: 'path',
      repoPath: '/a',
      baseBranch: 'main',
      fetchBeforeLaunch: true,
    })
    expect(out[1]).toEqual({ kind: 'url', repoUrl: 'git@h:o/b.git', ref: '' })
  })
})

describe('bodyToRepoSources — fallback', () => {
  test('empty / unrecognized body → one default empty path row (fresh form)', () => {
    expect(bodyToRepoSources({})).toEqual([defaultRepoSource()])
  })
})

describe('bodyToRepoSources — round-trips through the forward builders', () => {
  test('single path: inverse(buildLaunchBody(src)) === [src]', () => {
    const src: RepoSource = { kind: 'path', repoPath: '/r', baseBranch: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf', name: 'n', inputs: {} })
    expect(bodyToRepoSources(body)).toEqual([src])
  })

  test('single url: inverse(buildLaunchBody(src)) === [src]', () => {
    const src: RepoSource = { kind: 'url', repoUrl: 'git@h:o/r.git', ref: 'main' }
    const body = buildLaunchBody(src, { workflowId: 'wf', name: 'n', inputs: {} })
    expect(bodyToRepoSources(body)).toEqual([src])
  })

  test('multi-repo: inverse(buildLaunchBodyMultiRepo(repos)) === repos', () => {
    const repos: RepoSource[] = [
      { kind: 'path', repoPath: '/a', baseBranch: 'main' },
      { kind: 'url', repoUrl: 'git@h:o/b.git', ref: 'dev' },
    ]
    const body = buildLaunchBodyMultiRepo(repos, { workflowId: 'wf', name: 'n', inputs: {} })
    expect(bodyToRepoSources(body)).toEqual(repos)
  })

  test('path + fetchBeforeLaunch round-trips the flag', () => {
    const src: RepoSource = {
      kind: 'path',
      repoPath: '/r',
      baseBranch: 'main',
      fetchBeforeLaunch: true,
    }
    const body = buildLaunchBody(src, { workflowId: 'wf', name: 'n', inputs: {} })
    expect(bodyToRepoSources(body)).toEqual([src])
  })
})
