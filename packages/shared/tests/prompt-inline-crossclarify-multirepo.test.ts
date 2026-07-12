// LOCKS: RFC-026 (inline clarify session mode) × RFC-066 (multi-repo builtin
// tokens) — the untested INTERSECTION of these independent feature flags inside
// `renderUserPrompt` (packages/shared/src/prompt.ts).
//
// Why this file exists (regression it locks):
//
//   GAP 2 — inline-mode clarify rerun of a MULTI-REPO task.
//     The BUILTIN_VARS switch resolves __repos__ / __repo_names__ /
//     __repo_count__ BEFORE the `if (inlineMode) return ''` guard, so the
//     RFC-066 trio resolves to real per-repo values even in an inline rerun,
//     while ordinary input port tokens drop to ''. A refactor that hoisted the
//     inlineMode check above the builtin switch would silently blank out
//     __repos__ in clarify reruns of multi-repo tasks.
//     prompt-multi-repo-vars.test.ts never sets clarifyContext.
//
// (GAP 1 — inline × cross-clarify update mode — was deleted by RFC-148 along
// with the dead crossClarifyContext render path.)

import { describe, expect, test } from 'bun:test'
import { renderUserPrompt } from '../src/prompt'

describe('renderUserPrompt — RFC-026 inline mode × RFC-066 multi-repo tokens (GAP 2)', () => {
  const multiRepoInput = {
    promptTemplate:
      'P={{port_a}}|RP={{__repo_path__}}|R={{__repos__}}|N={{__repo_names__}}|C={{__repo_count__}}',
    inputs: { port_a: 'BODY' },
    meta: {
      repoPath: '/legacy',
      baseBranch: 'main',
      taskId: '01',
      repos: [
        { repoPath: '/p/a', worktreePath: '/w/01/a', worktreeDirName: 'a', baseBranch: 'main' },
        { repoPath: '/p/b', worktreePath: '/w/01/b', worktreeDirName: 'b', baseBranch: 'main' },
      ],
    },
    agentOutputs: ['result'],
    // RFC-100: an inline rerun only happens for a clarify channel; mark it
    // active (continue round — RFC-148: directive 'mandatory') so the trailer
    // is the inline reminder, not the stop-round output block
    // (mandatory-ask-back-first routing in renderUserPrompt).
    clarifyChannel: {
      kind: 'self' as const,
      directive: 'mandatory' as const,
      injectStopNotice: false,
    },
    clarifyContext: { mode: 'inline' as const },
  }

  test('inline-mode rerun drops port value but resolves all RFC-066 multi-repo builtins', () => {
    const out = renderUserPrompt(multiRepoInput)
    // port_a dropped to '' by inline mode; __repo_path__/__repos__/
    // __repo_names__/__repo_count__ all resolved to real per-repo values
    // because the builtin switch runs BEFORE the inlineMode `return ''` guard.
    expect(out.startsWith('P=|RP=/legacy|R=/w/01/a\n/w/01/b|N=a\nb|C=2')).toBe(true)
  })

  test('inline-mode rerun skips the ## port_a auto-append and uses the inline reminder trailer', () => {
    const out = renderUserPrompt(multiRepoInput)
    // Auto-append for input ports is skipped in inline mode.
    expect(out).not.toContain('## port_a')
    // Trailing block is the inline reminder, not the legacy output protocol.
    expect(out).toContain('The user has answered your previous')
    expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
  })
})
