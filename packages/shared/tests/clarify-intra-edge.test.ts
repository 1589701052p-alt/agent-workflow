// RFC-023 (+ RFC-056) — supplementary edge-coverage for the clarify envelope
// parser + answer synthesiser in packages/shared/src/clarify.ts.
//
// This file locks three intra-module branches that the existing clarify suites
// (clarify-schemas, clarify-utils, clarify-baseline-*, cross-clarify-*) never
// exercise:
//
//   GAP 1 — parseClarifyEnvelopeBody can return a NON-empty warnings[] AND a
//           non-empty errors[] together with body=null. The truncation warning
//           (clarify-questions-too-many, src L119) is pushed BEFORE the
//           per-element scan; a malformed kept element (src L130) then forces
//           body=null at L148-150 WITHOUT clearing the warning. Every other
//           test asserts EITHER warnings-only (body intact) OR errors-only —
//           a refactor that early-returns on the warning, or scrubs warnings
//           when errors exist, would silently break operator logs.
//
//   GAP 2 — the per-element "question[i] must be an object" guard (src
//           L127-135) that runs BEFORE zod. A null / primitive / array element
//           is rejected with a clarify-questions-malformed error keyed on the
//           POST-truncation array index. No existing test feeds a malformed
//           array ELEMENT (only malformed JSON / missing questions / zod-path
//           failures), and the legacy string lifting is at OPTION level, not
//           QUESTION level, so a top-level string element is genuinely an error.
//
//   GAP 3 — summariseClarifyAnswer single-choice with BOTH a selected label
//           AND non-empty customText emits the documented sixth branch
//           `User chose: "X" (additional note: "...")` (src L320-321, a
//           deliberate tolerance for the UI mutual-exclusion violation), plus
//           the whitespace-only customText boundary where .trim() (src L310)
//           reduces it to empty so the note is suppressed.

import { describe, expect, test } from 'bun:test'

import { parseClarifyEnvelopeBody, summariseClarifyAnswer } from '../src/clarify'

const optAB = [
  { label: 'A', description: '', recommended: false, recommendationReason: '' },
  { label: 'B', description: '', recommended: false, recommendationReason: '' },
]

const singleQ = {
  id: 'q',
  title: 't',
  kind: 'single' as const,
  recommended: false,
  options: optAB,
}

const multiQ = {
  id: 'q',
  title: 't',
  kind: 'multi' as const,
  recommended: false,
  options: optAB,
}

describe('GAP 1 — parse: truncation warning + per-element error coexist (body=null, warnings preserved)', () => {
  test('7 questions (truncated to 5) with a null at index < 5 yields BOTH a too-many warning and a malformed error', () => {
    // 6 valid questions then a trailing null = 7 total → truncated to first 5;
    // BUT we deliberately put the null at an index < 5 so the per-element scan
    // reaches it after the truncation warning was already pushed.
    const valid = (i: number) => ({
      id: `q${i}`,
      title: 't',
      kind: 'single' as const,
      options: ['a', 'b'],
    })
    const questions: unknown[] = [
      valid(0),
      valid(1),
      null, // index 2 — survives the slice(0, 5)
      valid(3),
      valid(4),
      valid(5),
      valid(6),
    ]
    const r = parseClarifyEnvelopeBody(JSON.stringify({ questions }))

    expect(r.body).toBe(null)
    expect(r.warnings.some((w) => w.code === 'clarify-questions-too-many')).toBe(true)
    expect(
      r.errors.some(
        (e) => e.code === 'clarify-questions-malformed' && e.detail.includes('must be an object'),
      ),
    ).toBe(true)
    // The malformed detail keys on the post-truncation index (2).
    expect(
      r.errors.some(
        (e) => e.code === 'clarify-questions-malformed' && e.detail.includes('question[2]'),
      ),
    ).toBe(true)
  })

  test('no truncation (3 questions) with a string element → errors-only, warnings stay empty', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          { id: 'q0', title: 't', kind: 'single', options: ['a', 'b'] },
          'not-an-object',
          { id: 'q2', title: 't', kind: 'single', options: ['a', 'b'] },
        ],
      }),
    )

    expect(r.body).toBe(null)
    expect(
      r.errors.some(
        (e) => e.code === 'clarify-questions-malformed' && e.detail.includes('question[1]'),
      ),
    ).toBe(true)
    expect(r.warnings).toEqual([])
  })
})

describe('GAP 2 — parse: per-element non-object guard ("question[i] must be an object")', () => {
  test('questions:[null] → single malformed error keyed on question[0]', () => {
    const r = parseClarifyEnvelopeBody(JSON.stringify({ questions: [null] }))
    expect(r.body).toBe(null)
    expect(r.errors[0]?.code).toBe('clarify-questions-malformed')
    expect(r.errors[0]?.detail.includes('question[0]')).toBe(true)
    expect(r.errors[0]?.detail.includes('must be an object')).toBe(true)
    expect(r.warnings).toEqual([])
  })

  test('questions:[[...]] (nested array element) → malformed, arrays are not objects here', () => {
    const r = parseClarifyEnvelopeBody(JSON.stringify({ questions: [['a', 'b']] }))
    expect(r.body).toBe(null)
    expect(
      r.errors.some(
        (e) => e.code === 'clarify-questions-malformed' && e.detail.includes('question[0]'),
      ),
    ).toBe(true)
  })

  test('questions:[42] (primitive element) → malformed at question[0]', () => {
    const r = parseClarifyEnvelopeBody(JSON.stringify({ questions: [42] }))
    expect(r.body).toBe(null)
    expect(r.errors.some((e) => e.detail.includes('question[0]'))).toBe(true)
  })
})

describe('GAP 3 — summariseClarifyAnswer: single label + custom tolerance + whitespace trim boundary', () => {
  test('single-choice with BOTH a label AND non-empty custom appends "(additional note: ...)"', () => {
    expect(
      summariseClarifyAnswer(singleQ, {
        questionId: 'q',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: 'and enable SSL',
      }),
    ).toBe('User chose: "Postgres" (additional note: "and enable SSL")')
  })

  test('single-choice with a label + whitespace-only custom → trimmed away, no note appended', () => {
    expect(
      summariseClarifyAnswer(singleQ, {
        questionId: 'q',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['Postgres'],
        customText: '   ',
      }),
    ).toBe('User chose: "Postgres"')
  })

  test('multi-choice with labels + whitespace-only custom → no "with additional note" trailer', () => {
    expect(
      summariseClarifyAnswer(multiQ, {
        questionId: 'q',
        selectedOptionIndices: [0, 1],
        selectedOptionLabels: ['A', 'B'],
        customText: '  \n ',
      }),
    ).toBe('User selected: "A", "B"')
  })
})
