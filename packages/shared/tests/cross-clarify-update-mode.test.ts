// RFC-056 §6 update mode (2026-05-22 amendment) — pure shared-layer locks.
//
// RFC-119 (2026-06-28): the prior-output heading + directive were UNIFIED to a
// neutral "update OR regenerate" wording and the constants renamed off the
// `CROSS_CLARIFY_` prefix (now shared by the cross-clarify update-mode path AND
// the generalized rerun path). This test keeps the cross-clarify-SPECIFIC
// guarantees:
//   1. `## Prior Output (to update or regenerate)` emits when
//      crossClarifyContext.priorOutputBlock is populated.
//   2. `## Update Directive` emits ONLY when priorOutputBlock is populated —
//      paired one-to-one so the directive never appears without the draft.
//   3. Section order (cross-clarify): Prior Output → External Feedback → Update
//      Directive (draft → change driver → "your action is update/regenerate").
//   4. buildPriorOutputBlock empty-input → empty string; single port → `### <port>`
//      + body; multi-port preserves caller order.
//
// The generalized (non-cross-clarify) rerun path is covered in
// rerun-prior-output.test.ts. If any of these go red the cross-clarify
// update-mode prompt contract has drifted — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  buildPriorOutputBlock,
  PRIOR_OUTPUT_BLOCK_TITLE,
  UPDATE_DIRECTIVE_BLOCK_TITLE,
  UPDATE_DIRECTIVE_TEXT,
  renderUserPrompt,
} from '@agent-workflow/shared'

describe('RFC-056 §6 update mode — buildPriorOutputBlock', () => {
  test('empty inputs → empty string (caller can suppress section)', () => {
    expect(buildPriorOutputBlock([])).toBe('')
  })

  test('single port → `### <port>` heading + content body', () => {
    const out = buildPriorOutputBlock([{ portName: 'design', content: '# Design v1\n...body...' }])
    expect(out).toContain('### design')
    expect(out).toContain('# Design v1')
    expect(out).toContain('...body...')
  })

  test('multi-port preserves caller order (NOT dictionary-sorted)', () => {
    const out = buildPriorOutputBlock([
      { portName: 'docpath', content: 'docs/design.md content' },
      { portName: 'summary', content: 'one-liner' },
    ])
    const docpathIdx = out.indexOf('### docpath')
    const summaryIdx = out.indexOf('### summary')
    expect(docpathIdx).toBeGreaterThan(-1)
    expect(summaryIdx).toBeGreaterThan(docpathIdx)
  })

  test('drops empty / whitespace-only content rows (no `### port_name` heading without body)', () => {
    const out = buildPriorOutputBlock([
      { portName: 'design', content: '   ' },
      { portName: 'summary', content: 'real content' },
    ])
    expect(out).not.toContain('### design')
    expect(out).toContain('### summary')
    expect(out).toContain('real content')
  })

  test('constants resolve to the literal strings (regression guard against silent rename)', () => {
    // RFC-119: heading is the NEUTRAL "update or regenerate" form, shared by both
    // prior-output paths.
    expect(PRIOR_OUTPUT_BLOCK_TITLE).toBe('## Prior Output (to update or regenerate)')
    expect(UPDATE_DIRECTIVE_BLOCK_TITLE).toBe('## Update Directive')
    expect(UPDATE_DIRECTIVE_TEXT.length).toBeGreaterThan(50)
    // RFC-119: the directive must offer BOTH update and regenerate (neutral) and
    // demand the COMPLETE output. It must NOT carry the old strict
    // "do NOT regenerate" bias.
    const lower = UPDATE_DIRECTIVE_TEXT.toLowerCase()
    expect(lower).toContain('update')
    expect(lower).toContain('regenerate')
    expect(lower).toContain('complete')
    expect(lower).not.toContain('not regenerate')
    expect(lower).not.toContain('do not regenerate')
  })
})

describe('RFC-056 §6 update mode — renderUserPrompt section emit + ordering', () => {
  test('emits `## Prior Output (to update or regenerate)` when crossClarifyContext.priorOutputBlock is set', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
        priorOutputBlock: '### design\n\n# Prior draft body',
      },
    })
    expect(out).toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).toContain('### design')
    expect(out).toContain('# Prior draft body')
  })

  test('emits `## Update Directive` ONLY when priorOutputBlock is also set (paired)', () => {
    // Case A: priorOutputBlock present → directive emits.
    const withPrior = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: 'feedback body',
        iteration: '1',
        sourcesCsv: '',
        priorOutputBlock: '### design\n\nbody',
      },
    })
    expect(withPrior).toContain(UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(withPrior).toContain('update')

    // Case B: priorOutputBlock empty → directive suppressed (would confuse
    // the agent — "update what?").
    const withoutPrior = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: 'feedback body',
        iteration: '1',
        sourcesCsv: '',
      },
    })
    expect(withoutPrior).not.toContain(UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(withoutPrior).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
  })

  test('section order: Prior Output → External Feedback → Update Directive (update-mode logical flow)', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: {},
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
      crossClarifyContext: {
        block: "### From 'auditor' (round 1)\n#### Q1: foo\n- bar",
        iteration: '1',
        sourcesCsv: 'auditor',
        priorOutputBlock: '### design\n\nbody',
      },
    })
    const priorIdx = out.indexOf(PRIOR_OUTPUT_BLOCK_TITLE)
    const externalIdx = out.indexOf('## External Feedback')
    const directiveIdx = out.indexOf(UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(priorIdx).toBeGreaterThan(-1)
    expect(externalIdx).toBeGreaterThan(priorIdx)
    expect(directiveIdx).toBeGreaterThan(externalIdx)
  })

  test('legacy path: no crossClarifyContext → no Prior Output / Update Directive sections', () => {
    const out = renderUserPrompt({
      promptTemplate: 'Body.',
      inputs: { requirement: 'something' },
      meta: { repoPath: '', baseBranch: '', taskId: 't1' },
      agentOutputs: ['design'],
    })
    expect(out).not.toContain(PRIOR_OUTPUT_BLOCK_TITLE)
    expect(out).not.toContain(UPDATE_DIRECTIVE_BLOCK_TITLE)
    expect(out).not.toContain('## External Feedback')
    expect(out).toContain('## requirement')
    expect(out).toContain('something')
  })
})
