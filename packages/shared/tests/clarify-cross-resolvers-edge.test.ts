// RFC-056 — shared/clarify.ts cross-clarify topology RESOLVER edge cases.
//
// LOCKS the behavioural contracts of the cross-clarify graph resolvers that
// the backend scheduler/runner depend on but that had ZERO direct test
// coverage (grep for these export names across packages/*/tests previously
// returned nothing):
//
//   * findCrossClarifyNodeForQuestioner — two-stage (portName THEN node-kind)
//     filter: must pick the 'clarify-cross-agent' target and IGNORE a
//     plain self-'clarify' node wired on the SAME questioner.__clarify__
//     source port (the mixed self+cross coexistence the frontend drag helper
//     explicitly allows). A dropped kind guard would silently mis-route the
//     questioner. (clarify.ts:626-640)
//   * findCrossClarifyNodesPointingToDesigner — Set dedup + stable sort keyed
//     on definition.nodes declaration index (NOT alphabetical / insertion).
//     evaluateDesignerRerunReadiness iterates this list so order drives the
//     UI's pendingCrossClarifyNodeIds. (clarify.ts:679-693)
//   * findDesignerNodeForCrossClarify / findQuestionerNodeForCrossClarify —
//     BOTH endpoints' port names must match; a half-matching edge yields
//     undefined. Loosening either side to a single-port check would
//     mis-resolve dispatch/correlation. (clarify.ts:661-673 / 699-711)
//   * isClarifyChannelEdge — the load-bearing scheduler guard that keeps the
//     questioner↔cc↔designer cycle out of the dataflow DAG. Each of its 5
//     channel-port OR branches must independently flip it true; an ordinary
//     dataflow edge must be false. (clarify.ts:612-620)
//   * agentHasExternalFeedbackChannel — designer-end probe (inbound
//     __external_feedback__), false for the questioner end (which only has
//     __clarify_response__ inbound). (clarify.ts:646-655)
//   * buildCrossClarifyAutoEdges — the SHARED reverse-drag helper's
//     deterministic edge-id scheme `e_{q}_{cc}_clarify` / `_to_questioner`
//     (distinct from the frontend ulid-based crossClarifyDragHelper). A silent
//     rename of the id template would break idempotent re-wiring. (clarify.ts:718-735)
//   * buildExternalFeedbackBlock — designer-side fan-in: Answers list renders
//     per-question in QUESTION order, interleaving custom-only / multi+note /
//     unanswered synthesis, and silently drops orphan answers whose questionId
//     is absent from src.questions. (clarify.ts:445-468)
//
// If any of these go red the cross-clarify routing / prompt assembly has
// drifted — investigate before relaxing.

import { describe, expect, test } from 'bun:test'

import type { ClarifyAnswer, ClarifyQuestion } from '../src/schemas/clarify'
import type { WorkflowDefinition, WorkflowEdge } from '../src/schemas/workflow'
import {
  agentHasExternalFeedbackChannel,
  buildCrossClarifyAutoEdges,
  buildExternalFeedbackBlock,
  findCrossClarifyNodeForQuestioner,
  findCrossClarifyNodesPointingToDesigner,
  findDesignerNodeForCrossClarify,
  findQuestionerNodeForCrossClarify,
  isClarifyChannelEdge,
} from '../src/clarify'

// --- local harness (replicated from clarify-cross-rfc056.test.ts) -----------

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

function edge(
  id: string,
  sourceNodeId: string,
  sourcePort: string,
  targetNodeId: string,
  targetPort: string,
): WorkflowEdge {
  return {
    id,
    source: { nodeId: sourceNodeId, portName: sourcePort },
    target: { nodeId: targetNodeId, portName: targetPort },
  }
}

// Minimal node fixtures. The resolvers only read id + (sometimes) kind, but
// build a structurally valid WorkflowDefinition so the test exercises the
// real public types.
function def(
  nodes: Array<{ id: string; kind: 'agent-single' | 'clarify' | 'clarify-cross-agent' }>,
  edges: WorkflowEdge[],
): WorkflowDefinition {
  return {
    $schema_version: 4,
    inputs: [],
    nodes: nodes.map((n) => {
      if (n.kind === 'agent-single') {
        return { id: n.id, kind: 'agent-single', agentName: n.id, prompt: '' }
      }
      return { id: n.id, kind: n.kind, title: '', description: '' }
    }),
    edges,
  } as unknown as WorkflowDefinition
}

// --- GAP 1: findCrossClarifyNodeForQuestioner kind guard --------------------

describe('GAP1 findCrossClarifyNodeForQuestioner — kind guard disambiguates mixed self+cross', () => {
  test('questioner.__clarify__ wired to BOTH a self-clarify and a cross-clarify node → returns ONLY the clarify-cross-agent id', () => {
    const d = def(
      [
        { id: 'questioner', kind: 'agent-single' },
        { id: 'selfClar', kind: 'clarify' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      [
        // plain self-clarify on the SAME source port — must be skipped.
        edge('e_self', 'questioner', '__clarify__', 'selfClar', 'questions'),
        // cross-clarify — the only valid match.
        edge('e_cross', 'questioner', '__clarify__', 'cc1', 'questions'),
      ],
    )
    expect(findCrossClarifyNodeForQuestioner(d, 'questioner')).toBe('cc1')
  })

  test('self-clarify only (kind "clarify") → undefined (kind guard rejects)', () => {
    const d = def(
      [
        { id: 'questioner', kind: 'agent-single' },
        { id: 'selfClar', kind: 'clarify' },
      ],
      [edge('e_self', 'questioner', '__clarify__', 'selfClar', 'questions')],
    )
    expect(findCrossClarifyNodeForQuestioner(d, 'questioner')).toBeUndefined()
  })

  test('edge targets a node id absent from def.nodes → undefined (tgt?.kind short-circuits)', () => {
    const d = def(
      [{ id: 'questioner', kind: 'agent-single' }],
      [edge('e_ghost', 'questioner', '__clarify__', 'ghost', 'questions')],
    )
    expect(findCrossClarifyNodeForQuestioner(d, 'questioner')).toBeUndefined()
  })
})

// --- GAP 2: findCrossClarifyNodesPointingToDesigner dedup + node-order ------

describe('GAP2 findCrossClarifyNodesPointingToDesigner — dedup + definition.nodes order', () => {
  test('three cc nodes fan in (one duplicated) → deduped, ordered by def.nodes declaration NOT alphabetical', () => {
    const d = def(
      [
        { id: 'designer', kind: 'agent-single' },
        { id: 'ccZ', kind: 'clarify-cross-agent' },
        { id: 'ccA', kind: 'clarify-cross-agent' },
        { id: 'ccM', kind: 'clarify-cross-agent' },
      ],
      [
        edge('e1', 'ccZ', 'to_designer', 'designer', '__external_feedback__'),
        // duplicate ccZ edge (different edge id) — must collapse to one entry.
        edge('e1dup', 'ccZ', 'to_designer', 'designer', '__external_feedback__'),
        edge('e2', 'ccA', 'to_designer', 'designer', '__external_feedback__'),
        edge('e3', 'ccM', 'to_designer', 'designer', '__external_feedback__'),
      ],
    )
    expect(findCrossClarifyNodesPointingToDesigner(d, 'designer')).toEqual(['ccZ', 'ccA', 'ccM'])
  })

  test('decoy edge with wrong source port (to_questioner) is excluded', () => {
    const d = def(
      [
        { id: 'designer', kind: 'agent-single' },
        { id: 'ccZ', kind: 'clarify-cross-agent' },
        { id: 'ccA', kind: 'clarify-cross-agent' },
        { id: 'ccM', kind: 'clarify-cross-agent' },
      ],
      [
        edge('e1', 'ccZ', 'to_designer', 'designer', '__external_feedback__'),
        edge('e2', 'ccA', 'to_designer', 'designer', '__external_feedback__'),
        edge('e3', 'ccM', 'to_designer', 'designer', '__external_feedback__'),
        // decoy: right target node/port, WRONG source port → must be excluded.
        edge('e_decoy', 'ccA', 'to_questioner', 'designer', '__external_feedback__'),
      ],
    )
    expect(findCrossClarifyNodesPointingToDesigner(d, 'designer')).toEqual(['ccZ', 'ccA', 'ccM'])
  })

  test('cc node absent from def.nodes → included, falls back to order 0', () => {
    const d = def(
      [{ id: 'designer', kind: 'agent-single' }],
      [edge('e1', 'cc1', 'to_designer', 'designer', '__external_feedback__')],
    )
    expect(findCrossClarifyNodesPointingToDesigner(d, 'designer')).toEqual(['cc1'])
  })
})

// --- GAP 3: two-sided port-name predicates ----------------------------------

describe('GAP3 findDesignerNodeForCrossClarify / findQuestionerNodeForCrossClarify — both endpoints must match', () => {
  test('findDesignerNodeForCrossClarify: cc1.to_designer → designer.__external_feedback__ → "designer"', () => {
    const d = def(
      [
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single' },
      ],
      [edge('e1', 'cc1', 'to_designer', 'designer', '__external_feedback__')],
    )
    expect(findDesignerNodeForCrossClarify(d, 'cc1')).toBe('designer')
  })

  test('findDesignerNodeForCrossClarify: right source port but WRONG target port → undefined', () => {
    const d = def(
      [
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single' },
      ],
      [edge('e1', 'cc1', 'to_designer', 'designer', 'someOtherPort')],
    )
    expect(findDesignerNodeForCrossClarify(d, 'cc1')).toBeUndefined()
  })

  test('findQuestionerNodeForCrossClarify: questioner.__clarify__ → cc1.questions → "questioner"', () => {
    const d = def(
      [
        { id: 'questioner', kind: 'agent-single' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      [edge('e1', 'questioner', '__clarify__', 'cc1', 'questions')],
    )
    expect(findQuestionerNodeForCrossClarify(d, 'cc1')).toBe('questioner')
  })

  test('findQuestionerNodeForCrossClarify: right target port but WRONG source port (main) → undefined', () => {
    const d = def(
      [
        { id: 'someAgent', kind: 'agent-single' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
      ],
      [edge('e1', 'someAgent', 'main', 'cc1', 'questions')],
    )
    expect(findQuestionerNodeForCrossClarify(d, 'cc1')).toBeUndefined()
  })
})

// --- GAP 4: isClarifyChannelEdge — 5 independent OR branches + false case ---

describe('GAP4 isClarifyChannelEdge — each of 5 channel ports independently flips true', () => {
  test('source.portName === "__clarify__" only → true', () => {
    expect(isClarifyChannelEdge(edge('e', 'q', '__clarify__', 'cc', 'questions'))).toBe(true)
  })

  test('target.portName === "__clarify_response__" only → true', () => {
    expect(isClarifyChannelEdge(edge('e', 'cc', 'main', 'q', '__clarify_response__'))).toBe(true)
  })

  test('target.portName === "__external_feedback__" only → true', () => {
    expect(isClarifyChannelEdge(edge('e', 'cc', 'main', 'designer', '__external_feedback__'))).toBe(
      true,
    )
  })

  test('source.portName === "to_designer" only → true', () => {
    expect(isClarifyChannelEdge(edge('e', 'cc', 'to_designer', 'designer', 'requirement'))).toBe(
      true,
    )
  })

  test('source.portName === "to_questioner" only → true', () => {
    expect(isClarifyChannelEdge(edge('e', 'cc', 'to_questioner', 'q', 'requirement'))).toBe(true)
  })

  test('ordinary dataflow edge (main → requirement) → false', () => {
    expect(isClarifyChannelEdge(edge('e', 'designer', 'main', 'consumer', 'requirement'))).toBe(
      false,
    )
  })
})

// --- GAP 5: agentHasExternalFeedbackChannel + buildCrossClarifyAutoEdges -----

describe('GAP5 agentHasExternalFeedbackChannel + buildCrossClarifyAutoEdges', () => {
  test('designer with inbound __external_feedback__ → true', () => {
    const d = def(
      [
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single' },
      ],
      [edge('e1', 'cc1', 'to_designer', 'designer', '__external_feedback__')],
    )
    expect(agentHasExternalFeedbackChannel(d, 'designer')).toBe(true)
  })

  test('questioner end (only __clarify_response__ inbound, no __external_feedback__) → false', () => {
    const d = def(
      [
        { id: 'questioner', kind: 'agent-single' },
        { id: 'cc1', kind: 'clarify-cross-agent' },
        { id: 'designer', kind: 'agent-single' },
      ],
      [
        edge('e_ask', 'questioner', '__clarify__', 'cc1', 'questions'),
        edge('e_ans', 'cc1', 'to_questioner', 'questioner', '__clarify_response__'),
        edge('e_des', 'cc1', 'to_designer', 'designer', '__external_feedback__'),
      ],
    )
    expect(agentHasExternalFeedbackChannel(d, 'questioner')).toBe(false)
  })

  test('buildCrossClarifyAutoEdges mints exactly two edges with stable ids + wiring', () => {
    const edges = buildCrossClarifyAutoEdges('q1', 'cc1')
    expect(edges).toEqual([
      {
        id: 'e_q1_cc1_clarify',
        source: { nodeId: 'q1', portName: '__clarify__' },
        target: { nodeId: 'cc1', portName: 'questions' },
      },
      {
        id: 'e_q1_cc1_to_questioner',
        source: { nodeId: 'cc1', portName: 'to_questioner' },
        target: { nodeId: 'q1', portName: '__clarify_response__' },
      },
    ])
  })
})

// --- GAP 6: buildExternalFeedbackBlock multi-question mixed-answer synthesis -

describe('GAP6 buildExternalFeedbackBlock — per-question Answers in question order; orphan dropped', () => {
  const out = buildExternalFeedbackBlock([
    {
      sourceQuestionerNodeId: 'aud',
      crossClarifyNodeId: 'cc1',
      iteration: 2,
      questions: [
        mkQ('q1', 'Q-one', 'single'),
        mkQ('q2', 'Q-two', 'multi'),
        mkQ('q3', 'Q-three', 'single'),
      ],
      answers: [
        mkA('q1', [], 'freeform'),
        mkA('q2', ['A', 'B'], 'note'),
        // orphan answer for a non-existent question id — must be dropped.
        mkA('qX', ['ghost'], ''),
      ],
    },
  ])

  test('Answers list emits per-question, in question order, with mixed synthesis', () => {
    const lines = out.split('\n')
    const q1Line = lines.findIndex((l) =>
      l.includes('- Q1 (Q-one): User chose custom answer: "freeform"'),
    )
    const q2Line = lines.findIndex((l) =>
      l.includes('- Q2 (Q-two): User selected: "A", "B" with additional note: "note"'),
    )
    const q3Line = lines.findIndex((l) =>
      l.includes('- Q3 (Q-three): User did not answer this question.'),
    )
    expect(q1Line).toBeGreaterThan(-1)
    expect(q2Line).toBeGreaterThan(-1)
    expect(q3Line).toBeGreaterThan(-1)
    // Question order, not answer-array order.
    expect(q1Line).toBeLessThan(q2Line)
    expect(q2Line).toBeLessThan(q3Line)
  })

  test('orphan answer (qX) is silently dropped — "ghost" never appears', () => {
    expect(out).not.toContain('ghost')
  })

  test('question-detail headings shifted to #### (no bare ### Q heading leaks)', () => {
    expect(out).toContain('#### Q1: Q-one')
    expect(out).toContain('#### Q2: Q-two')
    expect(out).not.toMatch(/^### Q/m)
  })
})
