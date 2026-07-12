// RFC-119 / RFC-141 — generalized rerun prior-output (shared render layer).
//
// When a NON-cross-clarify rerun (review reject/iterate, manual retry, cascade,
// resume, clarify-answer, ask-back round, override handoff) carries a
// `priorOutputUpdate.block`, renderUserPrompt appends a `## Prior Output` +
// directive pair:
//   - output rounds → `## Prior Output (to update or regenerate)` +
//     `## Update Directive` (RFC-119 D4 neutral wording);
//   - mandatory ask-back rounds → `## Prior Output (your previous run's
//     output)` + `## Prior Output Directive` (RFC-141: the agent must frame its
//     QUESTIONS around revising the draft — it must NOT emit output this round).
//
// RFC-141 flipped RFC-119 D6 ("suppress on ask-back") by user ruling: cross-
// clarify multi-round flows made "has a draft + ask-back active" a routine
// combination (evidence: task 01KWFZRQFPZFQQEM8JTCHQMGP5 node agent_m7p3n1
// retry 17 — 4 docpath generations, prompt carried none). The old suppression
// test is now inverted into the ask-back-variant lock below.
//
// These pure locks pin:
//   - both directive wordings + both heading pairs, and that neither variant
//     leaks into the other's rounds;
//   - emit only when block is non-empty;
//   - suppression on inline-session resume (RFC-119 D5, kept by RFC-141);
//   - placement after review/clarify feedback, before the trailing protocol.
//
// The scheduler-side selector/injection (which prior run, D10 iterate-target
// filter, file ports) is covered in
// packages/backend/tests/rerun-prior-output-injection.test.ts.

import { describe, expect, test } from 'bun:test'

import {
  ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE,
  ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE,
  ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT,
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

describe('RFC-141 — ask-back directive wording lock', () => {
  test('clarify-only + revise-framing + settled-decision + file guidance; no output demand', () => {
    const lower = ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT.toLowerCase()
    // must re-state the clarify-only protocol, not contradict it
    expect(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT).toContain('<workflow-clarify>')
    expect(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT).toContain('NO <workflow-output>')
    // questions framed around revising the draft
    expect(lower).toContain('questions')
    expect(lower).toContain('revised')
    // settled decisions stay settled
    expect(lower).toContain('re-litigate')
    expect(lower).toContain('clarify q&a')
    // file-path port guidance (D8 carries over)
    expect(lower).toContain('file path')
    expect(lower).toContain('read that file')
    // it must NOT demand emitting the complete output (that is the update variant)
    expect(lower).not.toContain('complete updated output')
  })

  test('ask-back headings are distinct from the update pair', () => {
    expect(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE).toBe("## Prior Output (your previous run's output)")
    expect(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE).toBe('## Prior Output Directive')
    expect(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE).not.toBe(PRIOR_OUTPUT_BLOCK_TITLE)
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

  test('suppressed on inline session resume (clarifyContext.mode=inline)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      clarifyContext: {
        mode: 'inline',
      },
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    expect(out).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).not.toContain(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).not.toContain('GEN_DRAFT')
  })

  test('RFC-141: mandatory ask-back INJECTS the ask-back variant (flips RFC-119 D6)', () => {
    // Was: "suppressed on mandatory ask-back". User-ruled inversion — a clarify-
    // only round with a prior draft must see that draft and ask about revising it.
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    expect(out).toContain(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).toContain('GEN_DRAFT')
    expect(out).toContain(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_BLOCK_TITLE)
    expect(out).toContain(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT)
    // the update pair must NOT leak into an ask-back round...
    expect(out).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).not.toContain(UPDATE_DIRECTIVE_TEXT)
    // ...and the trailing protocol stays the mandatory clarify-only preamble
    // (draft + ask-back protocol coexist); the output protocol block is absent.
    expect(out).toContain('MANDATORY ASK-BACK')
    expect(out).not.toContain('You MUST end your reply with a `<workflow-output>` block')
  })

  test('RFC-141 golden lock: same input, mandatory-directive flip swaps the variant pair exactly', () => {
    const base = {
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    }
    const output = renderUserPrompt(base)
    const askback = renderUserPrompt({
      ...base,
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
    })
    // output round: update pair only
    expect(output).toContain(UPDATE_DIRECTIVE_TEXT)
    expect(output).not.toContain(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE)
    expect(output).not.toContain(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT)
    // ask-back round: ask-back pair only
    expect(askback).toContain(ASKBACK_PRIOR_OUTPUT_DIRECTIVE_TEXT)
    expect(askback).not.toContain(UPDATE_DIRECTIVE_TEXT)
    // both carry the draft exactly once
    expect(output.split('GEN_DRAFT').length - 1).toBe(1)
    expect(askback.split('GEN_DRAFT').length - 1).toBe(1)
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

  test('RFC-141 placement: ask-back draft sits after the Clarify Q&A block, before the clarify protocol', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: META,
      agentOutputs: ['design'],
      clarifyChannel: { kind: 'self', directive: 'mandatory', injectStopNotice: false },
      clarifyContext: { flatBlock: '## Clarify Q&A\n- Q1 → yes' },
      priorOutputUpdate: { block: '### design\n\nGEN_DRAFT' },
    })
    const qaIdx = out.indexOf('## Clarify Q&A')
    const priorIdx = out.indexOf(ASKBACK_PRIOR_OUTPUT_BLOCK_TITLE)
    // 'MANDATORY ASK-BACK' only occurs in the trailing clarify preamble — the
    // directive text's own '<workflow-clarify>' mention would false-anchor.
    const protocolIdx = out.indexOf('MANDATORY ASK-BACK')
    expect(qaIdx).toBeGreaterThanOrEqual(0)
    expect(priorIdx).toBeGreaterThan(qaIdx)
    expect(protocolIdx).toBeGreaterThan(priorIdx)
  })
})
