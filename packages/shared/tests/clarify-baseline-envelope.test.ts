// RFC-058 PR-A baseline (T1): byte-level lock of parseClarifyEnvelopeBody +
// parseCrossClarifyEnvelopeBody current behavior. These tests are written to
// fail loudly if PR-B changes the parse result format / warning codes / error
// codes / question count semantics — that is the regression signal PR-B uses
// to confirm zero byte diff on the envelope path.
//
// Locks: RFC-023 self path (5-question cap, options ≤4 truncation, error
// codes) + RFC-056 cross path (lifts question cap, keeps option cap).

import { describe, expect, test } from 'bun:test'

import { CLARIFY_MAX_OPTIONS_PER_QUESTION, CLARIFY_MAX_QUESTIONS } from '../src/schemas/clarify'
import { parseClarifyEnvelopeBody, parseCrossClarifyEnvelopeBody } from '../src/index'

describe('RFC-058 baseline — parseClarifyEnvelopeBody self path (5-cap)', () => {
  test('self happy 3-question body: errors/warnings empty, body intact', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            title: 'Database choice?',
            kind: 'single',
            options: [
              { label: 'Postgres', recommended: true, recommendationReason: 'mature, ACID' },
              { label: 'MySQL', description: 'widely deployed' },
            ],
          },
          {
            id: 'q2',
            title: 'Language?',
            kind: 'multi',
            options: ['Python', 'TypeScript', 'Go'],
          },
        ],
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(2)
    // RFC-023 iter #2: recommended-first sort within options
    expect(r.body?.questions[0]?.options.map((o) => o.label)).toEqual(['Postgres', 'MySQL'])
    // Description / recommendationReason carry through verbatim
    expect(r.body?.questions[0]?.options[0]?.recommendationReason).toBe('mature, ACID')
    expect(r.body?.questions[0]?.options[1]?.description).toBe('widely deployed')
  })

  test('self truncates > 5 questions → 1 warning code "clarify-questions-too-many"', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: Array.from({ length: 7 }, (_, i) => ({
          id: `q${i}`,
          title: `Title ${i}`,
          kind: 'single',
          options: ['A', 'B'],
        })),
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]?.code).toBe('clarify-questions-too-many')
    expect(r.warnings[0]?.detail).toBe(`got 7 questions, truncated to ${CLARIFY_MAX_QUESTIONS}`)
    expect(r.body?.questions.length).toBe(CLARIFY_MAX_QUESTIONS)
  })

  test('options > 4 per question → 1 warning code "clarify-options-too-many"', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            title: 'Pick one',
            kind: 'single',
            options: ['A', 'B', 'C', 'D', 'E', 'F'],
          },
        ],
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]?.code).toBe('clarify-options-too-many')
    expect(r.warnings[0]?.detail).toBe(
      `question "q1" had 6 options, truncated to ${CLARIFY_MAX_OPTIONS_PER_QUESTION}`,
    )
    expect(r.body?.questions[0]?.options.length).toBe(CLARIFY_MAX_OPTIONS_PER_QUESTION)
    // First 4 are kept (no sort needed because none are recommended)
    expect(r.body?.questions[0]?.options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D'])
  })

  test('malformed JSON: body=null + "clarify-questions-malformed" error', () => {
    const r = parseClarifyEnvelopeBody('{not json')
    expect(r.body).toBeNull()
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.code).toBe('clarify-questions-malformed')
    expect(r.errors[0]?.detail).toContain('JSON.parse failed')
  })

  test('missing questions array: body=null + "clarify-questions-malformed" error', () => {
    const r = parseClarifyEnvelopeBody(JSON.stringify({ foo: 1 }))
    expect(r.body).toBeNull()
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.code).toBe('clarify-questions-malformed')
  })

  test('options < 2: emits "clarify-options-too-few" error (RFC-023 envelope rule)', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [{ id: 'q1', title: 'Pick one', kind: 'single', options: ['only-one'] }],
      }),
    )
    expect(r.body).toBeNull()
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]?.code).toBe('clarify-options-too-few')
  })
})

describe('RFC-058 baseline — parseCrossClarifyEnvelopeBody cross path (no question cap)', () => {
  test('cross accepts 7-question body without truncation (lifts the 5-cap)', () => {
    const r = parseCrossClarifyEnvelopeBody(
      JSON.stringify({
        questions: Array.from({ length: 7 }, (_, i) => ({
          id: `q${i}`,
          title: `T${i}`,
          kind: 'single',
          options: ['A', 'B'],
        })),
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(7)
  })

  test('cross still truncates options > 4 with the same warning code as self', () => {
    const r = parseCrossClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          {
            id: 'qx',
            title: 'Pick',
            kind: 'single',
            options: ['A', 'B', 'C', 'D', 'E'],
          },
        ],
      }),
    )
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]?.code).toBe('clarify-options-too-many')
    expect(r.body?.questions[0]?.options.length).toBe(CLARIFY_MAX_OPTIONS_PER_QUESTION)
  })

  test('cross 1-question body parses (RFC-056 v1 requires ≥1 question)', () => {
    const r = parseCrossClarifyEnvelopeBody(
      JSON.stringify({
        questions: [{ id: 'q1', title: 'single round', kind: 'single', options: ['Y', 'N'] }],
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(1)
  })

  test('cross still rejects per-question kind enum violations (cross-clarify ≠ self only on question cap)', () => {
    const r = parseCrossClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          {
            id: 'qy',
            title: 'Bad kind',
            kind: 'tristate' /* not in enum */,
            options: ['A', 'B'],
          },
        ],
      }),
    )
    expect(r.body).toBeNull()
    expect(r.errors.length).toBeGreaterThanOrEqual(1)
    expect(r.errors[0]?.code).toBe('clarify-questions-malformed')
  })
})
