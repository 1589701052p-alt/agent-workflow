// RFC-023 — shared schema invariants for the clarify node.
//
// Locks the contract surface that the backend runner / scheduler / clarify
// service and the frontend canvas / forms all build on. The 5 cases here
// are the floor referenced by RFC-023 plan.md T1 §B3.

import { describe, expect, test } from 'bun:test'

import {
  ClarifyAnswerSchema,
  ClarifyEnvelopeBodySchema,
  ClarifyNodeSchema,
  ClarifyQuestionSchema,
  ClarifySessionSchema,
  CLARIFY_MAX_OPTIONS_PER_QUESTION,
  CLARIFY_MAX_QUESTIONS,
  CLARIFY_MIN_OPTIONS_PER_QUESTION,
  NODE_KIND,
  NodeKindSchema,
  SubmitClarifyAnswersSchema,
  TASK_STATUS,
  TaskStatusSchema,
  WorkflowDefinitionSchema,
  WORKFLOW_SCHEMA_VERSION,
  WORKFLOW_SCHEMA_VERSIONS,
} from '../src/index'

describe('RFC-023 NODE_KIND + WORKFLOW_SCHEMA_VERSION', () => {
  test('NODE_KIND includes "clarify" as the 8th leaf node kind', () => {
    expect(NODE_KIND).toContain('clarify')
    expect(NodeKindSchema.safeParse('clarify').success).toBe(true)
  })

  test('WORKFLOW_SCHEMA_VERSION ≥ 3 and read-set includes 1/2/3', () => {
    // RFC-056 bumped this to 4. Older read-set entries 1/2/3 must remain
    // accepted for transparent v3 → latest upgrade. The exact current
    // version is asserted by RFC-056's dedicated cross-clarify test.
    expect(WORKFLOW_SCHEMA_VERSION).toBeGreaterThanOrEqual(3)
    expect([...WORKFLOW_SCHEMA_VERSIONS]).toContain(1)
    expect([...WORKFLOW_SCHEMA_VERSIONS]).toContain(2)
    expect([...WORKFLOW_SCHEMA_VERSIONS]).toContain(3)
  })

  test('WorkflowDefinitionSchema accepts $schema_version=3 with a clarify node', () => {
    const def = WorkflowDefinitionSchema.parse({
      $schema_version: 3,
      inputs: [],
      nodes: [
        {
          id: 'clarify_1',
          kind: 'clarify',
          title: 'Designer clarifications',
        },
      ],
      edges: [],
    })
    expect(def.$schema_version).toBe(3)
    expect(def.nodes[0]?.kind).toBe('clarify')
  })
})

describe('RFC-023 TASK_STATUS / NodeRunStatus', () => {
  test('TASK_STATUS includes "awaiting_human" alongside "awaiting_review"', () => {
    expect(TASK_STATUS).toContain('awaiting_human')
    expect(TASK_STATUS).toContain('awaiting_review')
    expect(TaskStatusSchema.safeParse('awaiting_human').success).toBe(true)
  })
})

describe('RFC-023 ClarifyQuestion + envelope body shape', () => {
  test('ClarifyQuestionSchema enforces 2..4 options + non-empty title', () => {
    const okSingle = ClarifyQuestionSchema.parse({
      id: 'q1',
      title: 'Which DB?',
      kind: 'single',
      recommended: true,
      options: ['Postgres', 'MySQL', 'SQLite'],
    })
    expect(okSingle.options.length).toBe(3)
    expect(okSingle.recommended).toBe(true)

    expect(
      ClarifyQuestionSchema.safeParse({
        id: 'q1',
        title: '',
        kind: 'single',
        options: ['A', 'B'],
      }).success,
    ).toBe(false)
    expect(
      ClarifyQuestionSchema.safeParse({
        id: 'q1',
        title: 'x',
        kind: 'single',
        options: ['only'],
      }).success,
    ).toBe(false)
    expect(
      ClarifyQuestionSchema.safeParse({
        id: 'q1',
        title: 'x',
        kind: 'single',
        options: ['1', '2', '3', '4', '5'],
      }).success,
    ).toBe(false)
    expect(CLARIFY_MIN_OPTIONS_PER_QUESTION).toBe(2)
    expect(CLARIFY_MAX_OPTIONS_PER_QUESTION).toBe(4)
  })

  test('ClarifyEnvelopeBodySchema caps total questions at 5', () => {
    const ok = ClarifyEnvelopeBodySchema.parse({
      questions: [
        { id: 'q1', title: 'a', kind: 'single', options: ['1', '2'] },
        { id: 'q2', title: 'b', kind: 'multi', options: ['1', '2', '3'] },
      ],
    })
    expect(ok.questions.length).toBe(2)

    expect(
      ClarifyEnvelopeBodySchema.safeParse({
        questions: Array.from({ length: 6 }, (_, i) => ({
          id: `q${i}`,
          title: 'x',
          kind: 'single',
          options: ['a', 'b'],
        })),
      }).success,
    ).toBe(false)
    expect(CLARIFY_MAX_QUESTIONS).toBe(5)
  })
})

describe('RFC-023 iter #2 — ClarifyOption per-option metadata + sort', () => {
  test('strings are lifted to ClarifyOption objects (backward compat with legacy envelopes)', () => {
    const q = ClarifyQuestionSchema.parse({
      id: 'q1',
      title: 'pick',
      kind: 'single',
      options: ['Postgres', 'MySQL'],
    })
    expect(q.options[0]).toEqual({
      label: 'Postgres',
      description: '',
      recommended: false,
      recommendationReason: '',
    })
    expect(q.options[1]?.label).toBe('MySQL')
  })

  test('object options preserve description / recommended / recommendationReason', () => {
    const q = ClarifyQuestionSchema.parse({
      id: 'q1',
      title: 'pick',
      kind: 'single',
      options: [
        {
          label: 'A',
          description: 'desc A',
          recommended: true,
          recommendationReason: 'why A',
        },
        { label: 'B' },
      ],
    })
    expect(q.options[0]).toEqual({
      label: 'A',
      description: 'desc A',
      recommended: true,
      recommendationReason: 'why A',
    })
    expect(q.options[1]?.description).toBe('')
    expect(q.options[1]?.recommended).toBe(false)
  })

  test('options are sorted: recommended first, original order preserved within group', () => {
    const q = ClarifyQuestionSchema.parse({
      id: 'q1',
      title: 'pick',
      kind: 'single',
      options: [
        { label: 'A' },
        { label: 'B', recommended: true },
        { label: 'C' },
        { label: 'D', recommended: true },
      ],
    })
    expect(q.options.map((o) => o.label)).toEqual(['B', 'D', 'A', 'C'])
  })

  test('mixed string and object options are normalised + sorted together', () => {
    const q = ClarifyQuestionSchema.parse({
      id: 'q1',
      title: 'pick',
      kind: 'single',
      options: ['plain1', { label: 'rec1', recommended: true }, 'plain2'],
    })
    expect(q.options.map((o) => o.label)).toEqual(['rec1', 'plain1', 'plain2'])
  })
})

describe('RFC-023 ClarifyAnswer + SubmitClarifyAnswers', () => {
  test('ClarifyAnswerSchema fills defaults for empty fields', () => {
    const a = ClarifyAnswerSchema.parse({ questionId: 'q1' })
    expect(a.selectedOptionIndices).toEqual([])
    expect(a.selectedOptionLabels).toEqual([])
    expect(a.customText).toBe('')
  })

  test('SubmitClarifyAnswers accepts ifMatchIteration optional lock', () => {
    const ok = SubmitClarifyAnswersSchema.parse({
      answers: [
        {
          questionId: 'q1',
          selectedOptionIndices: [0],
          selectedOptionLabels: ['Postgres'],
          customText: '',
        },
      ],
      ifMatchIteration: 0,
    })
    expect(ok.ifMatchIteration).toBe(0)
    expect(ok.answers[0]?.selectedOptionLabels).toEqual(['Postgres'])
  })
})

describe('RFC-023 ClarifyNode + ClarifySession', () => {
  test('ClarifyNodeSchema enforces kind="clarify" and tolerates passthrough fields', () => {
    const ok = ClarifyNodeSchema.parse({
      id: 'c1',
      kind: 'clarify',
      title: 'Q',
      // tolerated; passthrough() preserves it
      unknownExtra: 'ok',
    })
    expect(ok.kind).toBe('clarify')
    expect(ok.title).toBe('Q')
  })

  test('ClarifySessionSchema requires source/clarify ids + status enum', () => {
    const ok = ClarifySessionSchema.parse({
      id: 'sess1',
      taskId: 't',
      sourceAgentNodeId: 'agent_1',
      sourceAgentNodeRunId: 'nr1',
      sourceShardKey: null,
      clarifyNodeId: 'clarify_1',
      clarifyNodeRunId: 'nr2',
      iterationIndex: 0,
      questions: [{ id: 'q', title: 'x', kind: 'single', options: ['a', 'b'] }],
      status: 'awaiting_human',
      createdAt: 1,
      answeredAt: null,
      answeredBy: null,
    })
    expect(ok.status).toBe('awaiting_human')
    expect(ok.sourceShardKey).toBe(null)
  })
})
