// RFC-056 §6 update mode (2026-05-22 amendment) — pure shared-layer locks.
//
// RFC-119 (2026-06-28): the prior-output heading + directive were UNIFIED to a
// neutral "update OR regenerate" wording and the constants renamed off the
// `CROSS_CLARIFY_` prefix. RFC-148 deleted the dead crossClarifyContext render
// path; what remains here:
//   1. buildPriorOutputBlock empty-input → empty string; single port → `### <port>`
//      + body; multi-port preserves caller order.
//   2. A run with no prior-output context emits neither the Prior Output nor
//      the Update Directive section.
//
// The generalized rerun path is covered in rerun-prior-output.test.ts. If any
// of these go red the prior-output prompt contract has drifted — investigate
// before relaxing.

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
