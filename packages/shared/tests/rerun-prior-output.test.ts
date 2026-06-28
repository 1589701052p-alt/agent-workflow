// RFC-119 — generalized rerun prior-output (shared render layer).
//
// When a NON-cross-clarify rerun (review reject/iterate, manual retry, cascade,
// resume, self-clarify) carries a `priorOutputUpdate.block`, renderUserPrompt
// appends the same `## Prior Output (to update or regenerate)` + `## Update
// Directive` pair that cross-clarify uses (RFC-119 D4 unified the constants).
//
// These pure locks pin:
//   - the neutral directive wording (update OR regenerate, demand COMPLETE
//     output, file-path ports are re-read) — NOT the old strict "do not regenerate";
//   - emit only when block is non-empty;
//   - mutual exclusion with cross-clarify (never two prior-output blocks);
//   - suppression on inline-session resume + mandatory ask-back;
//   - placement after review/clarify feedback, before the trailing protocol.
//
// The scheduler-side selector/injection (which prior run, D10 iterate-target
// filter, file ports) is covered in
// packages/backend/tests/rerun-prior-output-injection.test.ts.

import { describe, expect, test } from 'bun:test'

import {
  PRIOR_OUTPUT_BLOCK_TITLE,
  UPDATE_DIRECTIVE_BLOCK_TITLE,
  UPDATE_DIRECTIVE_TEXT,
  renderUserPrompt,
} from '@agent-workflow/shared'

const META = { repoPath: '', baseBranch: '', taskId: 't1' } as const

describe('RFC-119 — directive wording lock', () => {
  test('neutral directive: update + regenerate + complete + file guidance, NOT strict "not regenerate"', () => {
    const lower = UPDATE_DIRECTIVE_TEXT.toLowerCase()
    expect(lower).toContain('update')
    expect(lower).toContain('regenerate')
    expect(lower).toContain('complete')
    // file-path port guidance (D8: file ports render a path; agent re-reads it)
    expect(lower).toContain('file path')
    expect(lower).toContain('read that file')
    // the old RFC-056 strict bias must be gone
    expect(lower).not.toContain('not regenerate')
    expect(lower).not.toContain('do not regenerate')
  })

  test('heading is the neutral shared title', () => {
    expect(PRIOR_OUTPUT_BLOCK_TITLE).toBe('## Prior Output (to update or regenerate)')
    expect(UPDATE_DIRECTIVE_BLOCK_TITLE).toBe('## Update Directive')
  })
})

describe('RFC-119 — renderUserPrompt priorOutputUpdate emit', () => {
  test('emits Prior Output + Update Directive when block is non-empty', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      priorOutputUpdate: { block: '### design\n\n# Prior body GEN_DRAFT' },
    })
    expect(out).toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).toContain('GEN_DRAFT')
    expect(out).toContain(UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(out).toContain(UPDATE_DIRECTIVE_TEXT)
  })

  test('empty / undefined block → no sections', () => {
    const empty = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      priorOutputUpdate: { block: '   ' },
    })
    expect(empty).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(empty).not.toContain(UPDATE_DIRECTIVE_BLOCK_TITLE)

    const none = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
    })
    expect(none).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
  })

  test('mutual exclusion with cross-clarify: xcc owns prior output, generalized suppressed (no duplicate)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: 'external feedback body',
        iteration: '1',
        sourcesCsv: 'auditor',
        priorOutputBlock: '### design\n\nXCC_DRAFT',
      },
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    // cross-clarify's block renders...
    expect(out).toContain('XCC_DRAFT')
    // ...and the generalized one does NOT (suppressed to avoid two prior-output blocks).
    expect(out).not.toContain('GEN_DRAFT')
    // exactly one Prior Output heading.
    expect(out.split(PRIOR_OUTPUT_BLOCK_TITLE).length - 1).toBe(1)
  })

  test('suppressed on inline session resume (clarifyContext.mode=inline)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      clarifyContext: {
        mode: 'inline',
        answersBlock: 'Q1: yes',
        directive: 'continue',
      },
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    expect(out).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).not.toContain('GEN_DRAFT')
  })

  test('suppressed on mandatory ask-back (hasClarifyChannel true)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      hasClarifyChannel: true,
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    expect(out).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).not.toContain('GEN_DRAFT')
  })

  test('placement: review feedback BEFORE Prior Output, Update Directive last', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      reviewContext: { comments: 'tighten section 3' },
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    const reviewIdx = out.indexOf('## Review Comments')
    const priorIdx = out.indexOf(PRIOR_OUTPUT_BLOCK_TITLE)
    const directiveIdx = out.indexOf(UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(reviewIdx).toBeGreaterThanOrEqual(0)
    expect(priorIdx).toBeGreaterThan(reviewIdx)
    expect(directiveIdx).toBeGreaterThan(priorIdx)
  })
})
