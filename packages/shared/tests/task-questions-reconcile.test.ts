// RFC-120 / RFC-162 — locks `reconcileDesiredEntries`: the pure derivation of a clarify
// round's "handler entries" (问题 × 承接角色) for the task question list.
//
// RFC-162 归一 (this file's current contract): a clarify question maps to EXACTLY ONE asker
// handler entry — self round → {self} (home = asking node); cross round → {questioner} (home =
// questioner node). The designer-by-default entry (formerly derived from the RFC-059 per-question
// `scope` + RFC-128 seal gate + RFC-120 T9 `directive`) is DELETED: reconcile NEVER emits a
// designer entry. "Let the upstream revise" is now a human reassign that ADDS a `designer`
// handler row (service-side — see reassignTaskQuestion), never derived here. Retired with this
// RFC-162 rewrite: the per-question seal gate, the scope split, the stop-directive suppression,
// and the "两条 case" — all locked the deleted designer-by-default behavior.
//
// Intent of each lock (so a future refactor that reddens it sees why):
//   * self round → exactly one {self} entry per question, default target = the asking node.
//   * cross round → exactly one {questioner} entry per question, default target = the questioner
//     node. NO designer entry, regardless of anything (single-card default — AC-1).
//   * graph nodes that don't resolve → defaultTargetNodeId is null (entry still collected; UI
//     prompts "no default handler, reassign").

import { describe, expect, test } from 'bun:test'
import { reconcileDesiredEntries, type ReconcileRoundInput } from '../src/task-questions'

const Q = (id: string, title = `q-${id}`) => ({ id, title })

const graph = {
  askingNodeId: 'ask',
  questionerNodeId: 'quest',
}

function run(partial: Partial<ReconcileRoundInput> & Pick<ReconcileRoundInput, 'kind'>) {
  return reconcileDesiredEntries({
    questions: [Q('q1')],
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
})

describe('reconcileDesiredEntries — cross (RFC-162 single card)', () => {
  test('AC-1: exactly one {questioner} entry per question, NO designer entry', () => {
    const out = run({ kind: 'cross', questions: [Q('q1'), Q('q2')] })
    expect(out.map((e) => `${e.questionId}:${e.roleKind}`)).toEqual([
      'q1:questioner',
      'q2:questioner',
    ])
    expect(out.every((e) => e.roleKind !== 'designer')).toBe(true)
    expect(out[0].defaultTargetNodeId).toBe('quest')
  })

  test('AC-1: a self round and a default cross round are structurally isomorphic', () => {
    const self = run({ kind: 'self', questions: [Q('q1')] })
    const cross = run({ kind: 'cross', questions: [Q('q1')] })
    // Same shape: one entry, home = the asking node (self=asking / cross=questioner), no designer.
    expect(self).toHaveLength(1)
    expect(cross).toHaveLength(1)
    expect(self[0].roleKind).toBe('self')
    expect(cross[0].roleKind).toBe('questioner')
    expect(self[0].defaultTargetNodeId).toBe('ask')
    expect(cross[0].defaultTargetNodeId).toBe('quest')
  })
})

describe('reconcileDesiredEntries — unresolved graph nodes', () => {
  test('null graph node → defaultTargetNodeId null, entry still collected', () => {
    const out = reconcileDesiredEntries({
      kind: 'cross',
      questions: [Q('q1')],
      graph: { askingNodeId: null, questionerNodeId: null },
    })
    expect(out).toHaveLength(1)
    expect(out[0].roleKind).toBe('questioner')
    expect(out[0].defaultTargetNodeId).toBeNull()
  })
})
