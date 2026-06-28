// RFC-120 — locks `reconcileDesiredEntries`: the pure derivation of a clarify
// round's "handler entries" (问题 × 承接角色) for the task question list.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * self round → exactly one {self} entry per question, default target = the
//     asking node (阻塞-产出型, not re-targetable).
//   * cross round → a {questioner} entry ALWAYS exists (the questioner re-runs
//     regardless of scope); a {designer} entry exists ONLY when the round is
//     answered AND that question's scope === 'designer'.
//   * **unanswered cross → questioner only, NO designer entry** — scope is an
//     answer-time human choice; before answering it is unknown, so we must NOT
//     synthesize a designer entry from CLARIFY_QUESTION_SCOPE_DEFAULT at create
//     time (design.md §3.1 / §2.2).
//   * answered cross with a missing scope key → falls back to designer (RFC-059
//     default) → designer entry present.
//   * graph nodes that don't resolve → defaultTargetNodeId is null (entry still
//     collected; UI prompts "no default handler, reassign").

import { describe, expect, test } from 'bun:test'
import { reconcileDesiredEntries, type ReconcileRoundInput } from '../src/task-questions'

const Q = (id: string, title = `q-${id}`) => ({ id, title })

const graph = {
  askingNodeId: 'ask',
  questionerNodeId: 'quest',
  designerNodeId: 'design',
}

function run(partial: Partial<ReconcileRoundInput> & Pick<ReconcileRoundInput, 'kind'>) {
  return reconcileDesiredEntries({
    questions: [Q('q1')],
    roundAnswered: false,
    scopes: {},
    graph,
    ...partial,
  })
}

describe('reconcileDesiredEntries — self', () => {
  test('one self entry per question, default target = asking node', () => {
    const out = run({ kind: 'self', questions: [Q('q1'), Q('q2')] })
    expect(out).toEqual([
      {
        questionId: 'q1',
        questionTitle: 'q-q1',
        sourceKind: 'self',
        roleKind: 'self',
        defaultTargetNodeId: 'ask',
      },
      {
        questionId: 'q2',
        questionTitle: 'q-q2',
        sourceKind: 'self',
        roleKind: 'self',
        defaultTargetNodeId: 'ask',
      },
    ])
  })

  test('self ignores roundAnswered / scopes entirely', () => {
    const answered = run({ kind: 'self', roundAnswered: true, scopes: { q1: 'questioner' } })
    const unanswered = run({ kind: 'self', roundAnswered: false })
    expect(answered).toEqual(unanswered)
  })
})

describe('reconcileDesiredEntries — cross unanswered (scope unknown)', () => {
  test('questioner entry only — NO designer entry before answering', () => {
    const out = run({ kind: 'cross', roundAnswered: false, questions: [Q('q1'), Q('q2')] })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q2:questioner',
    ])
    expect(out.every((e) => e.roleKind !== 'designer')).toBe(true)
    expect(out[0].defaultTargetNodeId).toBe('quest')
  })
})

describe('reconcileDesiredEntries — cross answered', () => {
  test('designer-scoped (default) → questioner + designer (the 两条 case)', () => {
    const out = run({ kind: 'cross', roundAnswered: true, scopes: { q1: 'designer' } })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner', 'designer'])
    const designer = out.find((e) => e.roleKind === 'designer')!
    expect(designer.defaultTargetNodeId).toBe('design')
  })

  test('questioner-scoped → questioner only', () => {
    const out = run({ kind: 'cross', roundAnswered: true, scopes: { q1: 'questioner' } })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner'])
  })

  test('missing scope key on answered round → designer fallback (RFC-059 default)', () => {
    const out = run({ kind: 'cross', roundAnswered: true, scopes: {} })
    expect(out.map((e) => e.roleKind)).toEqual(['questioner', 'designer'])
  })

  test('mixed scopes are per-question', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      roundAnswered: true,
      questions: [Q('q1'), Q('q2'), Q('q3')],
      scopes: { q1: 'designer', q2: 'questioner', q3: 'designer' },
      graph,
    })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q1:designer',
      'q2:questioner',
      'q3:questioner',
      'q3:designer',
    ])
  })
})

describe('reconcileDesiredEntries — unresolved graph nodes', () => {
  test('null graph node → defaultTargetNodeId null, entry still collected', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      roundAnswered: true,
      questions: [Q('q1')],
      scopes: { q1: 'designer' },
      graph: { askingNodeId: null, questionerNodeId: null, designerNodeId: null },
    })
    expect(out).toHaveLength(2)
    expect(out.every((e) => e.defaultTargetNodeId === null)).toBe(true)
  })
})
