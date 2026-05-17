// RFC-023 — pure-function helpers for the clarify node (envelope parsing,
// prompt block rendering, deterministic answer synthesis, definition-level
// edge helpers). Locks behaviour referenced by plan.md T2 §B3 + design.md §4.

import { describe, expect, test } from 'bun:test'

import {
  agentHasClarifyChannel,
  buildClarifyEdges,
  buildClarifyPromptBlock,
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  findClarifyNodeForAgent,
  parseClarifyEnvelopeBody,
  renderClarifyQuestionsBlock,
  summariseClarifyAnswer,
} from '../src/index'

describe('parseClarifyEnvelopeBody — happy + truncation', () => {
  test('parses a well-formed 2-question body', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            title: 'Which DB?',
            kind: 'single',
            recommended: true,
            options: ['Postgres', 'MySQL'],
          },
          { id: 'q2', title: 'Lang?', kind: 'multi', options: ['Py', 'TS'] },
        ],
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
    expect(r.body?.questions.length).toBe(2)
    expect(r.body?.questions[0]?.recommended).toBe(true)
  })

  test('truncates > 5 questions with a non-fatal warning', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: Array.from({ length: 7 }, (_, i) => ({
          id: `q${i}`,
          title: 'x',
          kind: 'single',
          options: ['a', 'b'],
        })),
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings[0]?.code).toBe('clarify-questions-too-many')
    expect(r.body?.questions.length).toBe(5)
  })

  test('truncates > 4 options per question with a warning', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [
          {
            id: 'q1',
            title: 'x',
            kind: 'single',
            options: ['a', 'b', 'c', 'd', 'e'],
          },
        ],
      }),
    )
    expect(r.errors).toEqual([])
    expect(r.warnings[0]?.code).toBe('clarify-options-too-many')
    expect(r.body?.questions[0]?.options.length).toBe(4)
  })

  test('rejects options < 2 with clarify-options-too-few', () => {
    const r = parseClarifyEnvelopeBody(
      JSON.stringify({
        questions: [{ id: 'q1', title: 'x', kind: 'single', options: ['only'] }],
      }),
    )
    expect(r.body).toBe(null)
    expect(r.errors.some((e) => e.code === 'clarify-options-too-few')).toBe(true)
  })

  test('rejects malformed JSON with clarify-questions-malformed', () => {
    const r = parseClarifyEnvelopeBody('not-json')
    expect(r.body).toBe(null)
    expect(r.errors[0]?.code).toBe('clarify-questions-malformed')
  })
})

const optAB = [
  { label: 'A', description: '', recommended: false, recommendationReason: '' },
  { label: 'B', description: '', recommended: false, recommendationReason: '' },
]
const optABC = [
  { label: 'A', description: '', recommended: false, recommendationReason: '' },
  { label: 'B', description: '', recommended: false, recommendationReason: '' },
  { label: 'C', description: '', recommended: false, recommendationReason: '' },
]

describe('summariseClarifyAnswer — 5 cases', () => {
  const single = {
    id: 'q',
    title: 't',
    kind: 'single' as const,
    recommended: false,
    options: optAB,
  }
  const multi = {
    id: 'q',
    title: 't',
    kind: 'multi' as const,
    recommended: false,
    options: optABC,
  }

  test('single + selected = "User chose"', () => {
    expect(
      summariseClarifyAnswer(single, {
        questionId: 'q',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['A'],
        customText: '',
      }),
    ).toBe('User chose: "A"')
  })

  test('single + custom only = "User chose custom answer"', () => {
    expect(
      summariseClarifyAnswer(single, {
        questionId: 'q',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: 'Redis',
      }),
    ).toBe('User chose custom answer: "Redis"')
  })

  test('multi + labels = "User selected"', () => {
    expect(
      summariseClarifyAnswer(multi, {
        questionId: 'q',
        selectedOptionIndices: [0, 1],
        selectedOptionLabels: ['A', 'B'],
        customText: '',
      }),
    ).toBe('User selected: "A", "B"')
  })

  test('multi + labels + custom = additional note', () => {
    expect(
      summariseClarifyAnswer(multi, {
        questionId: 'q',
        selectedOptionIndices: [0],
        selectedOptionLabels: ['A'],
        customText: 'plus C',
      }),
    ).toBe('User selected: "A" with additional note: "plus C"')
  })

  test('empty selection + empty custom = no-answer line', () => {
    expect(
      summariseClarifyAnswer(multi, {
        questionId: 'q',
        selectedOptionIndices: [],
        selectedOptionLabels: [],
        customText: '',
      }),
    ).toBe('User did not answer this question.')
  })
})

describe('renderClarifyQuestionsBlock + buildClarifyPromptBlock', () => {
  test('rendered question block surfaces per-option recommended + description + reason', () => {
    const md = renderClarifyQuestionsBlock([
      {
        id: 'q1',
        title: 'Which DB?',
        kind: 'single',
        recommended: false,
        options: [
          {
            label: 'Postgres',
            description: 'Battle-tested relational DB',
            recommended: true,
            recommendationReason: 'Default for transactional apps',
          },
          { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
        ],
      },
    ])
    expect(md).toContain('Q1: Which DB?')
    expect(md).toContain('1. Postgres [recommended]')
    expect(md).toContain('description: Battle-tested relational DB')
    expect(md).toContain('reason: Default for transactional apps')
    expect(md).toContain('2. MySQL')
    expect(md).toContain('Type: single-choice')
  })

  test('buildClarifyPromptBlock pairs each Q with one synthesis line only (no Type/Selected/Custom note redundancy)', () => {
    const md = buildClarifyPromptBlock(
      [
        {
          id: 'q1',
          title: 'Which DB?',
          kind: 'single',
          recommended: false,
          options: [
            {
              label: 'Postgres',
              description: '',
              recommended: false,
              recommendationReason: '',
            },
            { label: 'MySQL', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Postgres'],
          customText: '',
        },
      ],
    )
    // Only the synthesis line survives — Selected / Type / Custom note are
    // gone (the synthesis already says "User chose: Postgres").
    expect(md).toContain('Q1: Which DB?')
    expect(md).toContain('- User chose: "Postgres"')
    expect(md).not.toContain('Selected:')
    expect(md).not.toContain('Type:')
    expect(md).not.toContain('Synthesis:')
  })

  test('buildClarifyPromptBlock surfaces an unanswered question explicitly', () => {
    const md = buildClarifyPromptBlock(
      [
        {
          id: 'q1',
          title: 'Which DB?',
          kind: 'single',
          recommended: false,
          options: [
            { label: 'A', description: '', recommended: false, recommendationReason: '' },
            { label: 'B', description: '', recommended: false, recommendationReason: '' },
          ],
        },
      ],
      [],
    )
    expect(md).toContain('Q1: Which DB?')
    expect(md).toContain('- User did not answer this question.')
  })
})

describe('agentHasClarifyChannel / findClarifyNodeForAgent / buildClarifyEdges', () => {
  test('detects channel + finds the linked clarify node id', () => {
    const def = {
      $schema_version: 3 as const,
      inputs: [],
      nodes: [],
      edges: buildClarifyEdges('agent_1', 'clarify_1'),
    }
    expect(agentHasClarifyChannel(def, 'agent_1')).toBe(true)
    expect(agentHasClarifyChannel(def, 'agent_2')).toBe(false)
    expect(findClarifyNodeForAgent(def, 'agent_1')).toBe('clarify_1')
    // verify two edges shape
    expect(def.edges).toHaveLength(2)
    expect(def.edges[0]?.source.portName).toBe(CLARIFY_SOURCE_PORT_NAME)
    expect(def.edges[0]?.target.portName).toBe(CLARIFY_INPUT_PORT_NAME)
    expect(def.edges[1]?.source.portName).toBe(CLARIFY_OUTPUT_PORT_NAME)
    expect(def.edges[1]?.target.portName).toBe(CLARIFY_RESPONSE_TARGET_PORT_NAME)
  })
})
