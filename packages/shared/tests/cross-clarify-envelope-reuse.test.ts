// RFC-056 PR-D C1 — envelope-reuse 守门.
//
// Cross-clarify nodes reuse the RFC-023 `<workflow-clarify>` envelope verbatim:
// same JSON schema, same error codes, same option-truncation rules. The ONLY
// delta is that `parseClarifyEnvelopeBody({ maxQuestions: Infinity })`
// disables the 5-question count cap when called from the cross-clarify path.
//
// LOCKS:
//   1. The base (self-clarify) call still caps at CLARIFY_MAX_QUESTIONS = 5
//      and emits the `clarify-questions-too-many` warning at index 6+.
//   2. The cross-clarify call with `maxQuestions: Number.POSITIVE_INFINITY`
//      accepts arbitrarily many (≥ 6) questions without truncation warning.
//   3. Both callers receive the SAME error codes
//      (`clarify-questions-malformed`) on the same malformed payloads — the
//      delta is purely the count limit; the schema is otherwise byte-for-byte
//      identical.
//   4. Per-question option-cap (CLARIFY_MAX_OPTIONS_PER_QUESTION = 4) still
//      applies on both paths — it is not lifted alongside the question cap.
//
// If any of these go red the cross-clarify path has silently diverged from
// the RFC-023 envelope contract — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import {
  CLARIFY_MAX_OPTIONS_PER_QUESTION,
  CLARIFY_MAX_QUESTIONS,
  parseClarifyEnvelopeBody,
} from '@agent-workflow/shared'

function makeQuestionsPayload(count: number): string {
  const questions = Array.from({ length: count }, (_, i) => ({
    id: `q${i + 1}`,
    title: `Question ${i + 1}`,
    kind: 'single',
    recommended: false,
    options: ['A', 'B'],
  }))
  return JSON.stringify({ questions })
}

describe('RFC-056 C1 — envelope-reuse 守门', () => {
  test('self-clarify (no opts) caps at CLARIFY_MAX_QUESTIONS=5 and warns', () => {
    expect(CLARIFY_MAX_QUESTIONS).toBe(5)
    // 8 questions → truncate to 5, emit `clarify-questions-too-many` warning.
    const res = parseClarifyEnvelopeBody(makeQuestionsPayload(8))
    expect(res.body?.questions.length).toBe(5)
    expect(res.warnings.some((w) => w.code === 'clarify-questions-too-many')).toBe(true)
  })

  test('cross-clarify ({maxQuestions: Infinity}) accepts ≥ 6 questions without truncation', () => {
    const res = parseClarifyEnvelopeBody(makeQuestionsPayload(12), {
      maxQuestions: Number.POSITIVE_INFINITY,
    })
    expect(res.body?.questions.length).toBe(12)
    expect(res.warnings.some((w) => w.code === 'clarify-questions-too-many')).toBe(false)
    expect(res.errors).toEqual([])
  })

  test('error codes are identical on both paths for malformed JSON', () => {
    const malformed = '{not json'
    const selfRes = parseClarifyEnvelopeBody(malformed)
    const crossRes = parseClarifyEnvelopeBody(malformed, {
      maxQuestions: Number.POSITIVE_INFINITY,
    })
    expect(selfRes.errors.map((e) => e.code)).toEqual(crossRes.errors.map((e) => e.code))
    expect(selfRes.errors.some((e) => e.code === 'clarify-questions-malformed')).toBe(true)
  })

  test('error codes are identical on both paths for missing questions array', () => {
    const noQs = JSON.stringify({ foo: 'bar' })
    const selfRes = parseClarifyEnvelopeBody(noQs)
    const crossRes = parseClarifyEnvelopeBody(noQs, { maxQuestions: Number.POSITIVE_INFINITY })
    expect(selfRes.errors.map((e) => e.code)).toEqual(crossRes.errors.map((e) => e.code))
    expect(selfRes.errors.some((e) => e.code === 'clarify-questions-malformed')).toBe(true)
  })

  test('per-question option-cap (CLARIFY_MAX_OPTIONS_PER_QUESTION=4) is not lifted on cross path', () => {
    expect(CLARIFY_MAX_OPTIONS_PER_QUESTION).toBe(4)
    // Build a 1-question payload with 6 options on the cross path.
    const payload = JSON.stringify({
      questions: [
        {
          id: 'q1',
          title: 't',
          kind: 'single',
          recommended: false,
          options: ['A', 'B', 'C', 'D', 'E', 'F'],
        },
      ],
    })
    const res = parseClarifyEnvelopeBody(payload, { maxQuestions: Number.POSITIVE_INFINITY })
    expect(res.body?.questions[0]?.options.length).toBe(CLARIFY_MAX_OPTIONS_PER_QUESTION)
    expect(res.warnings.some((w) => w.code === 'clarify-options-too-many')).toBe(true)
  })

  test('default cap exactly at boundary (5 questions) — no warning', () => {
    const res = parseClarifyEnvelopeBody(makeQuestionsPayload(CLARIFY_MAX_QUESTIONS))
    expect(res.body?.questions.length).toBe(CLARIFY_MAX_QUESTIONS)
    expect(res.warnings.some((w) => w.code === 'clarify-questions-too-many')).toBe(false)
  })
})
