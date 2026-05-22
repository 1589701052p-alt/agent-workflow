// RFC-056 — shared/prompt.ts cross-clarify token substitution + auto-append.
//
// LOCKS:
//   * 3 new builtin tokens (__external_feedback__ / _iteration / _sources)
//     substitute cleanly when their context fields are populated.
//   * Auto-append fires only when token is not referenced AND block is
//     non-empty. Section heading is "## External Feedback" (locks via
//     CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE in clarify-cross.ts).
//   * Order at prompt tail: ## Self Clarify Q&A (RFC-023) → ## External
//     Feedback (RFC-056) → protocol block.
//
// If any of these go red the designer rerun prompt is malformed —
// investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE,
  renderUserPrompt,
} from '@agent-workflow/shared'

describe('RFC-056 cross-clarify builtin tokens', () => {
  test('{{__external_feedback__}} substitutes the rendered block', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.\n\nFeedback:\n{{__external_feedback__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
      },
    })
    expect(out).toContain("### From 'auditor' (round 1)")
    expect(out).toContain('- bar')
  })

  test('{{__external_feedback_iteration__}} substitutes designer cross-iter as string', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Round={{__external_feedback_iteration__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      crossClarifyContext: { block: '', iteration: '3', sourcesCsv: '' },
    })
    expect(out.startsWith('Round=3')).toBe(true)
  })

  test('{{__external_feedback_sources__}} substitutes comma-separated source ids', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Sources={{__external_feedback_sources__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      crossClarifyContext: { block: '', iteration: '1', sourcesCsv: 'security, ux' },
    })
    expect(out.startsWith('Sources=security, ux')).toBe(true)
  })

  test('missing context resolves all 3 tokens to empty (no crash, no garbage)', () => {
    const out = renderUserPrompt({
      promptTemplate:
        'a:{{__external_feedback__}}|b:{{__external_feedback_iteration__}}|c:{{__external_feedback_sources__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
    })
    expect(out.startsWith('a:|b:|c:')).toBe(true)
  })
})

describe('RFC-056 auto-append ## External Feedback', () => {
  test('auto-appends when template does NOT reference the token and block is non-empty', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
      },
    })
    expect(out).toContain(
      `${CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE}\n### From 'auditor' (round 1)`,
    )
  })

  test('does NOT auto-append when the template already referenced the token (avoids duplication)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Inline: {{__external_feedback__}}',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n",
        iteration: '1',
        sourcesCsv: 'auditor',
      },
    })
    // The block appears once via substitution; not a second time as a
    // `## External Feedback` auto-section.
    const occurrences = out.split("### From 'auditor' (round 1)").length - 1
    expect(occurrences).toBe(1)
    expect(out).not.toContain(`${CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE}\n### From 'auditor'`)
  })

  test('does NOT auto-append when block is empty / whitespace', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      crossClarifyContext: { block: '   ', iteration: '0', sourcesCsv: '' },
    })
    expect(out).not.toContain(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE)
  })

  test('ordering: ## Self Clarify Q&A then ## External Feedback then protocol block', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
      clarifyContext: {
        questionsBlock: '### Q1: prior\n- Type: single',
        answersBlock: '### Q1: prior\n- User chose: "X"',
        iteration: '1',
      },
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
      },
    })
    const clarifyIdx = out.indexOf('## Clarify Q&A')
    const externalIdx = out.indexOf('## External Feedback')
    const outputProtoIdx = out.indexOf('<workflow-output>')
    expect(clarifyIdx).toBeGreaterThan(-1)
    expect(externalIdx).toBeGreaterThan(clarifyIdx)
    expect(outputProtoIdx).toBeGreaterThan(externalIdx)
  })
})

describe('RFC-056 protocol block legacy path unchanged', () => {
  test('hasClarifyChannel = false + no cross context → still legacy single-envelope output', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['answer'],
    })
    expect(out).toContain('<workflow-output>')
    expect(out).not.toContain('## External Feedback')
  })
})
