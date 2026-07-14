// RFC-W004 T10 - locks in the to-agent answerer envelope contract:
// `<workflow-clarify-answer>` parsing + the answer/clarify/output 3-way mutex.
//
// Why this exists: answerer A (re-spawned with cause='clarify-to-agent-answer')
// must reply with EXACTLY ONE of <workflow-clarify-answer> (answer B) or
// <workflow-clarify> (escalate to a human via A's self-clarify). Emitting
// <workflow-output> alone, or any pair, fails the run (design §4 / proposal A5
// + A6). analyzeToAgentAnswererReply is the pure function the runner calls
// BEFORE the RFC-023 clarify/output dispatch (so a valid answer, which
// detectEnvelopeKind reports as 'none' because the answer tag is not in its
// regex set, is not misrouted to envelope-missing). If a future refactor moves
// the mutex out of analyzeToAgentAnswererReply or relaxes the 3-way rule, this
// guard must be updated explicitly - keep the assertions pointed so the
// failure message names the exact regression.
//
// Mirrors the RFC-023 clarify-envelope-exclusive.test.ts shape: pure-function
// cases + a source-grep that runner.ts actually wires the analyzer (so moving
// the call site away without renaming the helper silently bypasses the guard).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ClarifyAnswerEnvelopeSchema } from '@agent-workflow/shared'

import {
  analyzeToAgentAnswererReply,
  detectEnvelopeKind,
  extractClarifyAnswerEnvelopeBody,
} from '../src/services/envelope'

const ANSWER = (markdown: string) =>
  `<workflow-clarify-answer>{ "markdown": ${JSON.stringify(markdown)} }</workflow-clarify-answer>`
const OUTPUT = '<workflow-output><port name="x">v</port></workflow-output>'
const CLARIFY =
  '<workflow-clarify>{"questions":[{"id":"q","title":"?","kind":"single","recommended":false,"options":["A","B"]}]}</workflow-clarify>'

describe('RFC-W004 ClarifyAnswerEnvelopeSchema - answer body schema', () => {
  test('happy: { markdown } parses', () => {
    const parsed = ClarifyAnswerEnvelopeSchema.safeParse({ markdown: 'use port X' })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.markdown).toBe('use port X')
  })

  test('malformed: missing markdown / empty markdown / non-string are rejected', () => {
    expect(ClarifyAnswerEnvelopeSchema.safeParse({}).success).toBe(false)
    expect(ClarifyAnswerEnvelopeSchema.safeParse({ markdown: '' }).success).toBe(false)
    expect(ClarifyAnswerEnvelopeSchema.safeParse({ markdown: 42 }).success).toBe(false)
    expect(ClarifyAnswerEnvelopeSchema.safeParse({ answers: [] }).success).toBe(false)
  })
})

describe('RFC-W004 analyzeToAgentAnswererReply - 3-way answer/clarify/output mutex', () => {
  test('answer-only -> { kind: "answer" } (run stays done; scheduler routes to commitToAgentAnswerAndTriggerQuestioner)', () => {
    const reply = analyzeToAgentAnswererReply(ANSWER('Use port X with value Y.'))
    expect(reply.kind).toBe('answer')
    if (reply.kind === 'answer') expect(reply.answer.markdown).toBe('Use port X with value Y.')
  })

  test('answer + output -> fail clarify-to-agent-answer-and-output-both', () => {
    const reply = analyzeToAgentAnswererReply(`${ANSWER('ans')}\n${OUTPUT}`)
    expect(reply.kind).toBe('fail')
    if (reply.kind === 'fail') {
      expect(reply.code).toBe('clarify-to-agent-answer-and-output-both')
      expect(reply.message).toContain('clarify-to-agent-answer-and-output-both-present')
    }
  })

  test('answer + clarify -> fail clarify-to-agent-answer-and-clarify-both', () => {
    const reply = analyzeToAgentAnswererReply(`${ANSWER('ans')}\n${CLARIFY}`)
    expect(reply.kind).toBe('fail')
    if (reply.kind === 'fail') {
      expect(reply.code).toBe('clarify-to-agent-answer-and-clarify-both')
      expect(reply.message).toContain('clarify-to-agent-answer-and-clarify-both-present')
    }
  })

  test('output-only (no answer, no clarify) -> fail clarify-to-agent-timeout-no-answer', () => {
    const reply = analyzeToAgentAnswererReply(OUTPUT)
    expect(reply.kind).toBe('fail')
    if (reply.kind === 'fail') {
      expect(reply.code).toBe('clarify-to-agent-timeout-no-answer')
      expect(reply.message).toContain('clarify-to-agent-timeout-no-answer')
    }
  })

  test('clarify-only -> defer (A escalates via the RFC-023 clarify path; NOT a to-agent failure)', () => {
    const reply = analyzeToAgentAnswererReply(CLARIFY)
    expect(reply.kind).toBe('defer')
  })

  test('malformed answer body (bad JSON / missing markdown) -> fail clarify-to-agent-answer-malformed', () => {
    // bad JSON
    expect(
      analyzeToAgentAnswererReply('<workflow-clarify-answer>not json</workflow-clarify-answer>')
        .kind,
    ).toBe('fail')
    // missing markdown
    const reply = analyzeToAgentAnswererReply(
      '<workflow-clarify-answer>{ "foo": 1 }</workflow-clarify-answer>',
    )
    expect(reply.kind).toBe('fail')
    if (reply.kind === 'fail') expect(reply.code).toBe('clarify-to-agent-answer-malformed')
  })

  test('no envelope at all -> defer (RFC-023 dispatch fails it as envelope-missing)', () => {
    expect(analyzeToAgentAnswererReply('agent said hi').kind).toBe('defer')
  })

  test('answer+output+clarify (all three) fails on the answer+output pair first', () => {
    const reply = analyzeToAgentAnswererReply(`${ANSWER('ans')}\n${OUTPUT}\n${CLARIFY}`)
    expect(reply.kind).toBe('fail')
    if (reply.kind === 'fail') {
      // answer+output is checked before answer+clarify - the primary offense.
      expect(reply.code).toBe('clarify-to-agent-answer-and-output-both')
    }
  })
})

describe('RFC-W004 envelope tag disjointness', () => {
  test('<workflow-clarify-answer> does NOT trip the RFC-023 <workflow-clarify> detector', () => {
    // detectEnvelopeKind must keep reporting 'none' for a lone answer envelope
    // (the answer tag is only meaningful on a to-agent answerer run, analyzed
    // separately). This guards the regex disjointness claim in envelope.ts.
    expect(detectEnvelopeKind(ANSWER('ans'))).toBe('none')
  })

  test('extractClarifyAnswerEnvelopeBody returns the LAST answer body (mirrors clarify/output last-wins)', () => {
    const stdout = `${ANSWER('draft')}\n${ANSWER('final')}`
    expect(extractClarifyAnswerEnvelopeBody(stdout)).toBe('{ "markdown": "final" }')
    expect(extractClarifyAnswerEnvelopeBody('no answer here')).toBeNull()
  })
})

describe('RFC-W004 runner wiring (source-grep guard)', () => {
  test('runner.ts imports + calls analyzeToAgentAnswererReply and gates it on toAgentAnswererSources', () => {
    const runnerPath = join(__dirname, '..', 'src', 'services', 'runner.ts')
    const src = readFileSync(runnerPath, 'utf8')
    expect(src).toContain('analyzeToAgentAnswererReply')
    expect(src).toContain('opts.toAgentAnswererSources')
    expect(src).toContain('clarifyAnswerResult')
    // RunResult carries the parsed answer for the scheduler (T12) to consume.
    expect(src).toContain('clarifyAnswer')
  })
})
