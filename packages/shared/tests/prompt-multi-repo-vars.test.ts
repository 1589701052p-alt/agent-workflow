// LOCKS: RFC-066 PR-B T11 — three new prompt placeholders.
//
// Cases covered:
//   1. {{__repos__}} renders newline-joined worktreePath of every repo.
//   2. {{__repo_names__}} renders newline-joined worktreeDirName (empty
//      string for single-repo tasks, basename for multi-repo).
//   3. {{__repo_count__}} renders the length as a string ('1' for single,
//      'N' for multi).
//   4. meta.repos omitted → all three placeholders render to '' / '0'.
//   5. Templates that don't reference the new tokens get byte-baseline
//      output (RFC-024 / RFC-066 PR-A single-repo regression lock).
//   6. Legacy {{__repo_path__}} / {{__base_branch__}} continue to point at
//      the top-level repoPath/baseBranch (NOT at repos[0]) so existing
//      templates keep working unchanged.

import { describe, expect, test } from 'bun:test'
import { renderUserPrompt } from '../src/prompt'

const BASE_META = {
  repoPath: '/Users/dev/proj/agent-workflow',
  baseBranch: 'main',
  taskId: '01ABCD',
}

describe('renderUserPrompt — RFC-066 multi-repo placeholders', () => {
  test('1. {{__repos__}} renders newline-joined worktreePath', () => {
    const out = renderUserPrompt({
      promptTemplate: '{{__repos__}}',
      inputs: {},
      meta: {
        ...BASE_META,
        repos: [
          {
            repoPath: '/p/a',
            worktreePath: '/w/multi/01ABCD/a',
            worktreeDirName: 'a',
            baseBranch: 'main',
          },
          {
            repoPath: '/p/b',
            worktreePath: '/w/multi/01ABCD/b',
            worktreeDirName: 'b',
            baseBranch: 'main',
          },
        ],
      },
      agentOutputs: ['result'],
    })
    expect(out.startsWith('/w/multi/01ABCD/a\n/w/multi/01ABCD/b')).toBe(true)
  })

  test('2. {{__repo_names__}} renders newline-joined worktreeDirName', () => {
    const out = renderUserPrompt({
      promptTemplate: '{{__repo_names__}}',
      inputs: {},
      meta: {
        ...BASE_META,
        repos: [
          {
            repoPath: '/p/a',
            worktreePath: '/w/multi/01ABCD/utils',
            worktreeDirName: 'utils',
            baseBranch: 'main',
          },
          {
            repoPath: '/p/b',
            worktreePath: '/w/multi/01ABCD/utils-2',
            worktreeDirName: 'utils-2',
            baseBranch: 'main',
          },
        ],
      },
      agentOutputs: ['result'],
    })
    expect(out.startsWith('utils\nutils-2')).toBe(true)
  })

  test('3. {{__repo_count__}} renders the array length', () => {
    const out = renderUserPrompt({
      promptTemplate: 'COUNT={{__repo_count__}}',
      inputs: {},
      meta: {
        ...BASE_META,
        repos: [
          {
            repoPath: '/p/a',
            worktreePath: '/w/a',
            worktreeDirName: 'a',
            baseBranch: 'main',
          },
          {
            repoPath: '/p/b',
            worktreePath: '/w/b',
            worktreeDirName: 'b',
            baseBranch: 'main',
          },
          {
            repoPath: '/p/c',
            worktreePath: '/w/c',
            worktreeDirName: 'c',
            baseBranch: 'main',
          },
        ],
      },
      agentOutputs: ['result'],
    })
    expect(out.startsWith('COUNT=3')).toBe(true)
  })

  test('4. meta.repos omitted → placeholders render to empty / 0', () => {
    const out = renderUserPrompt({
      promptTemplate: 'R={{__repos__}}|N={{__repo_names__}}|C={{__repo_count__}}',
      inputs: {},
      meta: BASE_META,
      agentOutputs: ['result'],
    })
    expect(out.startsWith('R=|N=|C=0')).toBe(true)
  })

  test('5. single-repo task: worktreeDirName="" produces empty __repo_names__', () => {
    const out = renderUserPrompt({
      promptTemplate: 'R={{__repos__}}|N=[{{__repo_names__}}]|C={{__repo_count__}}',
      inputs: {},
      meta: {
        ...BASE_META,
        repos: [
          {
            repoPath: '/Users/dev/proj/agent-workflow',
            worktreePath: '/w/slug-01ABCD',
            worktreeDirName: '', // single-repo sentinel
            baseBranch: 'main',
          },
        ],
      },
      agentOutputs: ['result'],
    })
    expect(out.startsWith('R=/w/slug-01ABCD|N=[]|C=1')).toBe(true)
  })

  test('6. legacy {{__repo_path__}} / {{__base_branch__}} unchanged (point at meta top-level, not repos[0])', () => {
    const out = renderUserPrompt({
      promptTemplate: 'PATH={{__repo_path__}}|BRANCH={{__base_branch__}}',
      inputs: {},
      meta: {
        repoPath: '/legacy/repo',
        baseBranch: 'legacy-branch',
        taskId: '01ABCD',
        // intentionally different from top-level — proves the legacy
        // placeholders pull from the meta top, not from repos[0].
        repos: [
          {
            repoPath: '/other/repo',
            worktreePath: '/other/wt',
            worktreeDirName: 'other',
            baseBranch: 'other-branch',
          },
        ],
      },
      agentOutputs: ['result'],
    })
    expect(out.startsWith('PATH=/legacy/repo|BRANCH=legacy-branch')).toBe(true)
  })

  test('7. template without any new tokens → byte-baseline output (no leakage)', () => {
    const withRepos = renderUserPrompt({
      promptTemplate: 'static {{port_a}}',
      inputs: { port_a: 'foo' },
      meta: {
        ...BASE_META,
        repos: [
          {
            repoPath: '/a',
            worktreePath: '/wa',
            worktreeDirName: 'a',
            baseBranch: 'main',
          },
        ],
      },
      agentOutputs: ['result'],
    })
    const withoutRepos = renderUserPrompt({
      promptTemplate: 'static {{port_a}}',
      inputs: { port_a: 'foo' },
      meta: BASE_META,
      agentOutputs: ['result'],
    })
    expect(withRepos).toBe(withoutRepos)
  })
})
