// RFC-W004 - shared layer: <workflow-clarify-answer> envelope schema + the
// `## Clarify Request` prompt block builder (answerer A side).
//
// LOCKS: the answer envelope is the ONLY new envelope tag this RFC adds (B's
// questions reuse RFC-023 <workflow-clarify>). The Clarify Request block is
// the A-side injection surface (B's questions + the answer-or-escalate
// directive). If these go red the runner / scheduler injection contracts have
// drifted - investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  buildClarifyRequestBlock,
  CLARIFY_REQUEST_BLOCK_TITLE,
  ClarifyAnswerEnvelopeSchema,
  type ClarifyRequestSource,
} from '@agent-workflow/shared'

const mkQuestion = (id: string, title: string) => ({
  id,
  title,
  kind: 'single' as const,
  options: [{ label: 'a', recommended: true }, { label: 'b' }],
})

describe('RFC-W004 ClarifyAnswerEnvelopeSchema', () => {
  test('parses a valid answer (non-empty markdown)', () => {
    const res = ClarifyAnswerEnvelopeSchema.safeParse({
      markdown: 'Use Redis because X. P99 for the rate limit.',
    })
    expect(res.success).toBe(true)
  })

  test('rejects empty markdown (A must actually answer)', () => {
    expect(ClarifyAnswerEnvelopeSchema.safeParse({ markdown: '' }).success).toBe(false)
  })

  test('rejects missing markdown field', () => {
    expect(ClarifyAnswerEnvelopeSchema.safeParse({}).success).toBe(false)
  })

  test('rejects non-string markdown', () => {
    expect(ClarifyAnswerEnvelopeSchema.safeParse({ markdown: 42 }).success).toBe(false)
  })

  test('accepts multi-line markdown (A answers multiple questions in one blob)', () => {
    const md = '## Q1\nUse Redis.\n\n## Q2\nP99.'
    expect(ClarifyAnswerEnvelopeSchema.safeParse({ markdown: md }).success).toBe(true)
  })

  test('rejects unknown extra shape silently (forward-compat: no .strict())', () => {
    // v1 ignores extra keys so a future structured `answers` field can ride
    // alongside `markdown` without breaking older parsers (design §2.5).
    const res = ClarifyAnswerEnvelopeSchema.safeParse({
      markdown: 'ok',
      futureField: 'ignored',
    })
    expect(res.success).toBe(true)
  })
})

describe('RFC-W004 buildClarifyRequestBlock - answerer A injection', () => {
  test('renders the title + one source sub-section + the protocol directive', () => {
    const sources: ClarifyRequestSource[] = [
      { questionerNodeId: 'agent_b', questions: [mkQuestion('q1', 'Why Redis?')] },
    ]
    const block = buildClarifyRequestBlock(sources)
    expect(block).toBeDefined()
    expect(block).toContain(CLARIFY_REQUEST_BLOCK_TITLE)
    expect(block).toContain("### From 'agent_b'")
    expect(block).toContain('id: q1')
    expect(block).toContain('title: Why Redis?')
    expect(block).toContain('type: single-choice')
    // protocol directive
    expect(block).toContain('<workflow-clarify-answer>')
    expect(block).toContain('"markdown"')
    expect(block).toContain('<workflow-clarify>')
    expect(block).toContain('FAIL this run')
  })

  test('multiple sources sorted by questionerNodeId (deterministic)', () => {
    const sources: ClarifyRequestSource[] = [
      { questionerNodeId: 'z_agent', questions: [mkQuestion('qz', 'z?')] },
      { questionerNodeId: 'a_agent', questions: [mkQuestion('qa', 'a?')] },
      { questionerNodeId: 'm_agent', questions: [mkQuestion('qm', 'm?')] },
    ]
    const block = buildClarifyRequestBlock(sources)!
    const aIdx = block.indexOf("### From 'a_agent'")
    const mIdx = block.indexOf("### From 'm_agent'")
    const zIdx = block.indexOf("### From 'z_agent'")
    expect(aIdx).toBeLessThan(mIdx)
    expect(mIdx).toBeLessThan(zIdx)
  })

  test('multiple questions in one source render as separate bullets', () => {
    const sources: ClarifyRequestSource[] = [
      {
        questionerNodeId: 'agent_b',
        questions: [mkQuestion('q1', 'Why Redis?'), mkQuestion('q2', 'P50 or P99?')],
      },
    ]
    const block = buildClarifyRequestBlock(sources)!
    expect(block).toContain('id: q1')
    expect(block).toContain('id: q2')
    expect(block).toContain('title: P50 or P99?')
  })

  test('multi-choice question renders the multi-choice label', () => {
    const sources: ClarifyRequestSource[] = [
      {
        questionerNodeId: 'agent_b',
        questions: [
          {
            id: 'q1',
            title: 'pick all that apply',
            kind: 'multi' as const,
            options: [{ label: 'a', recommended: true }, { label: 'b' }],
          },
        ],
      },
    ]
    const block = buildClarifyRequestBlock(sources)!
    expect(block).toContain('type: multi-choice')
  })

  test('recommended options are annotated [recommended]', () => {
    const sources: ClarifyRequestSource[] = [
      { questionerNodeId: 'b', questions: [mkQuestion('q1', 'q')] },
    ]
    const block = buildClarifyRequestBlock(sources)!
    expect(block).toContain('a [recommended]')
  })

  test('returns undefined when all sources have no questions (no block to inject)', () => {
    expect(buildClarifyRequestBlock([{ questionerNodeId: 'b', questions: [] }])).toBeUndefined()
  })

  test('returns undefined for empty sources', () => {
    expect(buildClarifyRequestBlock([])).toBeUndefined()
  })

  test('filters out empty-question sources but keeps populated ones', () => {
    const sources: ClarifyRequestSource[] = [
      { questionerNodeId: 'empty_b', questions: [] },
      { questionerNodeId: 'full_b', questions: [mkQuestion('q1', 'q')] },
    ]
    const block = buildClarifyRequestBlock(sources)!
    expect(block).toContain("### From 'full_b'")
    expect(block).not.toContain("### From 'empty_b'")
  })

  test('protocol directive appears exactly once regardless of source count', () => {
    const one = buildClarifyRequestBlock([
      { questionerNodeId: 'b1', questions: [mkQuestion('q', 'q')] },
    ])!
    const three = buildClarifyRequestBlock([
      { questionerNodeId: 'b1', questions: [mkQuestion('q', 'q')] },
      { questionerNodeId: 'b2', questions: [mkQuestion('q', 'q')] },
      { questionerNodeId: 'b3', questions: [mkQuestion('q', 'q')] },
    ])!
    const countOne = (one.match(/<workflow-clarify-answer>/g) ?? []).length
    const countThree = (three.match(/<workflow-clarify-answer>/g) ?? []).length
    expect(countOne).toBe(1)
    expect(countThree).toBe(1)
  })
})
