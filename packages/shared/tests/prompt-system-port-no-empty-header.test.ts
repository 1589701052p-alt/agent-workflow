// shared/prompt.ts — system port auto-append filter regression.
//
// 2026-05-22 UI bug report: a designer prompt for cross-clarify rerun showed
// an empty `## __external_feedback__` section header at the top (auto-appended
// for the system port even though the real Q&A content goes through the
// dedicated `## External Feedback` block further down). Same shape for
// `__clarify_response__` on RFC-023 self-clarify reruns. The empty headers
// confused the human reader — they scanned for cross-clarify content under
// the obvious `## __external_feedback__` heading, found nothing, and
// concluded the framework didn't inject the cross-clarify Q&A at all.
//
// Fix: filter `__clarify_response__` + `__external_feedback__` (system ports
// whose payload is delivered via dedicated blocks) from the auto-append loop.
//
// LOCKS:
//   1. renderUserPrompt does NOT emit `## __clarify_response__` even when the
//      input map contains an entry for it.
//   2. renderUserPrompt does NOT emit `## __external_feedback__` even when
//      the input map contains an entry for it.
//   3. Non-system ports in the input map (e.g. `requirement`) still get the
//      `## requirement` auto-append section.
//   4. The dedicated `## External Feedback` block STILL renders when a
//      `crossClarifyContext` is provided (the real content path).

import { describe, expect, test } from 'bun:test'

import { renderUserPrompt } from '@agent-workflow/shared'

describe('shared/prompt — system port auto-append filter', () => {
  test('does NOT emit `## __external_feedback__` section header when only system port is in inputs', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {
        __external_feedback__: '', // system port — content is empty edge value
        requirement: '生成贪吃蛇游戏设计', // normal port — should render
      },
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
    })
    expect(out).not.toMatch(/^## __external_feedback__\b/m)
    // The normal port still renders.
    expect(out).toContain('## requirement')
    expect(out).toContain('生成贪吃蛇游戏设计')
  })

  test('does NOT emit `## __clarify_response__` section header when system port is in inputs', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {
        __clarify_response__: '',
        topic: '某个主题',
      },
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
    })
    expect(out).not.toMatch(/^## __clarify_response__\b/m)
    expect(out).toContain('## topic')
  })

  test('the dedicated `## External Feedback` block STILL renders when crossClarifyContext is provided', () => {
    // The whole point of the filter is to let the dedicated block (further
    // down) be the SINGLE place where cross-clarify Q&A surfaces — without
    // a spurious empty header confusing the human reader.
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {
        __external_feedback__: '', // system port — auto-append filter skips
      },
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
      },
    })
    // No empty `## __external_feedback__` header.
    expect(out).not.toMatch(/^## __external_feedback__\b/m)
    // Dedicated section renders with actual content.
    expect(out).toContain('## External Feedback')
    expect(out).toContain("### From 'auditor' (round 1)")
  })

  test('non-system `__` prefixed ports (none currently, but contract-safe) would still render', () => {
    // Sanity check: the filter is an EXPLICIT set of known system ports,
    // not a pattern match on `^__.*__$`. If someone adds a new user-facing
    // port that happens to use the underscore convention, it should NOT be
    // silently suppressed — only the explicit system-port set is filtered.
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {
        __some_user_port__: 'user content',
      },
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
    })
    expect(out).toContain('## __some_user_port__')
    expect(out).toContain('user content')
  })
})
