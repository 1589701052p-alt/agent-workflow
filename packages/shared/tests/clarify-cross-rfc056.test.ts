// RFC-056 — shared/clarify-cross.ts pure functions.
//
// LOCKS:
//   * parseCrossClarifyEnvelopeBody lifts the 5-question cap; per-question
//     validation (options 2-4, single/multi kind, custom-text length) still
//     funnels through the RFC-023 parser.
//   * resolveCrossClarifySessionMode returns the questioner session mode
//     (defaults to 'isolated'). The designer direction was removed by RFC-056
//     patch 2026-06-22 (dead config — designer rerun is always isolated).
//
// If any of these go red the runtime / prompt assembly for the cross-clarify
// path has drifted — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import type { ClarifyQuestion, ClarifyAnswer } from '@agent-workflow/shared'
import {
  CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE,
  parseCrossClarifyEnvelopeBody,
  resolveCrossClarifySessionMode,
  summariseCrossAnswer,
} from '@agent-workflow/shared'

function mkQ(id: string, title: string, kind: 'single' | 'multi' = 'single'): ClarifyQuestion {
  return {
    id,
    title,
    kind,
    recommended: false,
    options: [
      { label: 'A', description: '', recommended: false, recommendationReason: '' },
      { label: 'B', description: '', recommended: false, recommendationReason: '' },
    ],
  }
}

function mkA(qid: string, labels: string[] = [], custom = ''): ClarifyAnswer {
  return {
    questionId: qid,
    selectedOptionIndices: [],
    selectedOptionLabels: labels,
    customText: custom,
  }
}

describe('RFC-056 parseCrossClarifyEnvelopeBody — lifts question cap, keeps per-question rules', () => {
  test('accepts 1 question (lower bound preserved)', () => {
    const env = JSON.stringify({
      questions: [{ id: 'q1', title: 'one', kind: 'single', options: ['A', 'B'] }],
    })
    const r = parseCrossClarifyEnvelopeBody(env)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(1)
  })

  test('accepts 7 questions (RFC-023 would have truncated at 5)', () => {
    const questions = Array.from({ length: 7 }, (_, i) => ({
      id: `q${i + 1}`,
      title: `t${i + 1}`,
      kind: 'single',
      options: ['A', 'B'],
    }))
    const r = parseCrossClarifyEnvelopeBody(JSON.stringify({ questions }))
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(7)
  })

  test('still truncates per-question options at 4 (RFC-023 rule preserved)', () => {
    const env = JSON.stringify({
      questions: [
        {
          id: 'q1',
          title: 't',
          kind: 'single',
          options: ['A', 'B', 'C', 'D', 'E'],
        },
      ],
    })
    const r = parseCrossClarifyEnvelopeBody(env)
    expect(r.body?.questions[0]?.options.length).toBe(4)
    expect(r.warnings.some((w) => w.code === 'clarify-options-too-many')).toBe(true)
  })

  test('still rejects options < 2 (RFC-023 hard rule preserved)', () => {
    const env = JSON.stringify({
      questions: [{ id: 'q1', title: 't', kind: 'single', options: ['only'] }],
    })
    const r = parseCrossClarifyEnvelopeBody(env)
    expect(r.body).toBeNull()
    expect(r.errors.some((e) => e.code === 'clarify-options-too-few')).toBe(true)
  })

  test('rejects malformed JSON', () => {
    const r = parseCrossClarifyEnvelopeBody('not-json')
    expect(r.body).toBeNull()
    expect(r.errors.some((e) => e.code === 'clarify-questions-malformed')).toBe(true)
  })

  test('rejects empty questions array (lower bound 1)', () => {
    const r = parseCrossClarifyEnvelopeBody(JSON.stringify({ questions: [] }))
    expect(r.body).toBeNull()
    expect(r.errors.length).toBeGreaterThan(0)
  })
})

describe('RFC-056 summariseCrossAnswer — reuses RFC-023 single-question synthesis', () => {
  test('single chose option → User chose: "X"', () => {
    const q = mkQ('q1', 't')
    const a = mkA('q1', ['A'], '')
    expect(summariseCrossAnswer(q, a)).toBe('User chose: "A"')
  })

  test('multi with custom → User selected: ... with additional note: "..."', () => {
    const q = mkQ('q1', 't', 'multi')
    const a = mkA('q1', ['A', 'B'], 'note')
    expect(summariseCrossAnswer(q, a)).toBe('User selected: "A", "B" with additional note: "note"')
  })
})

describe('RFC-056 resolveCrossClarifySessionMode — questioner session mode', () => {
  test('missing field → isolated', () => {
    const node = {
      id: 'cc1',
      kind: 'clarify-cross-agent' as const,
      title: '',
      description: '',
    }
    expect(resolveCrossClarifySessionMode(node)).toBe('isolated')
  })

  test('explicit questioner field round-trips', () => {
    const node = {
      id: 'cc1',
      kind: 'clarify-cross-agent' as const,
      title: '',
      description: '',
      sessionModeForQuestioner: 'inline' as const,
    }
    expect(resolveCrossClarifySessionMode(node)).toBe('inline')
  })
})

describe('RFC-056 constant exports for grep-guard', () => {
  test('CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE locks the section heading', () => {
    expect(CROSS_CLARIFY_EXTERNAL_FEEDBACK_BLOCK_TITLE).toBe('## External Feedback')
  })
})
