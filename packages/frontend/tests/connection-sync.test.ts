// RFC-007 — pure-function locks for the connect / disconnect / form /
// heal helpers in `components/canvas/connectionSync.ts`. The integration
// test (canvas-review-output-drag.test.tsx) exercises the same helpers
// through WorkflowCanvas; these tests stay closer to the wire so we can
// pin invariants — single-input replacement, ref-equality short-circuits,
// YAML-import reverse heal — without React in the picture.
//
// If a case here goes red, check connectionSync.ts FIRST: the integration
// test is layered on top.

import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import {
  applyConnectionForReviewOutput,
  applyDisconnectForReviewOutput,
  healFieldEdgeConsistency,
  REVIEW_INPUT_HANDLE_ID,
  syncEdgeFromFormField,
} from '../src/components/canvas/connectionSync'

function makeDef(extra: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [],
    nodes: [],
    edges: [],
    ...extra,
  }
}

function agent(id: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    agentName: 'stub',
  } as unknown as WorkflowNode
}

function review(id: string, inputSource = { nodeId: '', portName: '' }): WorkflowNode {
  return {
    id,
    kind: 'review',
    inputSource,
  } as unknown as WorkflowNode
}

function output(
  id: string,
  ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>,
): WorkflowNode {
  return {
    id,
    kind: 'output',
    ports,
  } as unknown as WorkflowNode
}

// ---------------------------------------------------------------------------
// applyConnectionForReviewOutput
// ---------------------------------------------------------------------------

describe('applyConnectionForReviewOutput', () => {
  test('target is agent → returns def unchanged (only edges array mutated by caller)', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    }
    const def = makeDef({ nodes: [agent('a'), agent('b')], edges: [edge] })
    const next = applyConnectionForReviewOutput(def, edge)
    expect(next).toBe(def)
  })

  test('target is review with no prior edge → writes inputSource, edge count preserved', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a'), review('r')], edges: [edge] })
    const next = applyConnectionForReviewOutput(def, edge)
    expect(next.edges).toHaveLength(1)
    const r = next.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: 'a', portName: 'design' })
  })

  test('target is review with existing inbound edge → old edge dropped, new kept', () => {
    const oldEdge: WorkflowEdge = {
      id: 'old',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const newEdge: WorkflowEdge = {
      id: 'new',
      source: { nodeId: 'b', portName: 'spec' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({
      nodes: [agent('a'), agent('b'), review('r', { nodeId: 'a', portName: 'design' })],
      edges: [oldEdge, newEdge],
    })
    const next = applyConnectionForReviewOutput(def, newEdge)
    expect(next.edges).toEqual([newEdge])
    const r = next.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: 'b', portName: 'spec' })
  })

  test('target is output, drop on named handle → bind rewritten in place', () => {
    // Explicit rebind onto an existing named port — `opts.viaCatchAll` is
    // false / absent so we overwrite that port's bind, not auto-create.
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'o', portName: 'final_doc' },
    }
    const def = makeDef({
      nodes: [
        agent('a'),
        output('o', [
          { name: 'final_doc', bind: { nodeId: '', portName: '' } },
          { name: 'audit_report', bind: { nodeId: 'k', portName: 'x' } },
        ]),
      ],
      edges: [edge],
    })
    const next = applyConnectionForReviewOutput(def, edge)
    const o = next.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(o.ports).toHaveLength(2)
    expect(o.ports[0]?.bind).toEqual({ nodeId: 'a', portName: 'design' })
    // other port untouched
    expect(o.ports[1]?.bind).toEqual({ nodeId: 'k', portName: 'x' })
  })

  test('target is output, drop on catch-all of empty output → port auto-created', () => {
    // RFC-007 catch-all path on a fresh output node (`ports: []`):
    // materializes a new port named after the upstream port.
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'audit_md' },
      target: { nodeId: 'o', portName: 'audit_md' },
    }
    const def = makeDef({
      nodes: [agent('a'), output('o', [])],
      edges: [edge],
    })
    const next = applyConnectionForReviewOutput(def, edge, { viaCatchAll: true })
    expect(next).not.toBe(def)
    const o = next.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(o.ports).toHaveLength(1)
    expect(o.ports[0]).toEqual({
      name: 'audit_md',
      bind: { nodeId: 'a', portName: 'audit_md' },
    })
  })

  test('target is output, second catch-all drop with colliding name → port disambiguated `_2`', () => {
    // The hard requirement: output is multi-input. Two upstreams sharing
    // an output-port name (e.g. both call it `out`) must coexist on the
    // same output node — the second drop appends a `_2`-suffixed port and
    // the new edge's target.portName is rewritten to match.
    const edge: WorkflowEdge = {
      id: 'new',
      source: { nodeId: 'b', portName: 'out' },
      target: { nodeId: 'o', portName: 'out' },
    }
    const def = makeDef({
      nodes: [
        agent('a'),
        agent('b'),
        output('o', [{ name: 'out', bind: { nodeId: 'a', portName: 'out' } }]),
      ],
      edges: [
        {
          id: 'pre',
          source: { nodeId: 'a', portName: 'out' },
          target: { nodeId: 'o', portName: 'out' },
        },
        edge,
      ],
    })
    const next = applyConnectionForReviewOutput(def, edge, { viaCatchAll: true })
    const o = next.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(o.ports).toHaveLength(2)
    expect(o.ports[0]).toEqual({ name: 'out', bind: { nodeId: 'a', portName: 'out' } })
    expect(o.ports[1]).toEqual({ name: 'out_2', bind: { nodeId: 'b', portName: 'out' } })
    // Edge rewritten to land on the new port; pre-existing edge preserved.
    expect(next.edges).toHaveLength(2)
    const newEdge = next.edges.find((e) => e.id === 'new')!
    expect(newEdge.target.portName).toBe('out_2')
    const preEdge = next.edges.find((e) => e.id === 'pre')!
    expect(preEdge.target.portName).toBe('out')
  })

  test('target is output, catch-all drop with non-colliding name → port appended verbatim', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'b', portName: 'spec' },
      target: { nodeId: 'o', portName: 'spec' },
    }
    const def = makeDef({
      nodes: [
        agent('a'),
        agent('b'),
        output('o', [{ name: 'design', bind: { nodeId: 'a', portName: 'design' } }]),
      ],
      edges: [edge],
    })
    const next = applyConnectionForReviewOutput(def, edge, { viaCatchAll: true })
    const o = next.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(o.ports.map((p) => p.name)).toEqual(['design', 'spec'])
  })

  test('target node does not exist → returns def unchanged', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'ghost', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a')], edges: [edge] })
    const next = applyConnectionForReviewOutput(def, edge)
    expect(next).toBe(def)
  })
})

// ---------------------------------------------------------------------------
// applyDisconnectForReviewOutput
// ---------------------------------------------------------------------------

describe('applyDisconnectForReviewOutput', () => {
  test('removing the review inbound edge clears inputSource', () => {
    const def = makeDef({
      nodes: [agent('a'), review('r', { nodeId: 'a', portName: 'design' })],
      edges: [],
    })
    const removed: WorkflowEdge = {
      id: 'old',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const next = applyDisconnectForReviewOutput(def, [removed])
    const r = next.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: '', portName: '' })
  })

  test('removing an output port edge clears that port.bind only', () => {
    const def = makeDef({
      nodes: [
        agent('a'),
        output('o', [
          { name: 'final_doc', bind: { nodeId: 'a', portName: 'design' } },
          { name: 'audit_report', bind: { nodeId: 'b', portName: 'spec' } },
        ]),
      ],
      edges: [],
    })
    const removed: WorkflowEdge = {
      id: 'old',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'o', portName: 'final_doc' },
    }
    const next = applyDisconnectForReviewOutput(def, [removed])
    const o = next.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(o.ports[0]?.bind).toEqual({ nodeId: '', portName: '' })
    expect(o.ports[1]?.bind).toEqual({ nodeId: 'b', portName: 'spec' })
  })

  test('removing a normal agent inbound edge leaves def unchanged', () => {
    const def = makeDef({ nodes: [agent('a'), agent('b')], edges: [] })
    const removed: WorkflowEdge = {
      id: 'old',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    }
    const next = applyDisconnectForReviewOutput(def, [removed])
    expect(next).toBe(def)
  })

  test('removing multiple edges in one call clears all matching fields', () => {
    const def = makeDef({
      nodes: [
        agent('a'),
        review('r', { nodeId: 'a', portName: 'design' }),
        output('o', [{ name: 'final_doc', bind: { nodeId: 'a', portName: 'design' } }]),
      ],
      edges: [],
    })
    const removed: WorkflowEdge[] = [
      {
        id: 'er',
        source: { nodeId: 'a', portName: 'design' },
        target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
      },
      {
        id: 'eo',
        source: { nodeId: 'a', portName: 'design' },
        target: { nodeId: 'o', portName: 'final_doc' },
      },
    ]
    const next = applyDisconnectForReviewOutput(def, removed)
    const r = next.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    const o = next.nodes.find((n) => n.id === 'o')! as unknown as {
      ports: Array<{ name: string; bind: { nodeId: string; portName: string } }>
    }
    expect(r.inputSource).toEqual({ nodeId: '', portName: '' })
    expect(o.ports[0]?.bind).toEqual({ nodeId: '', portName: '' })
  })
})

// ---------------------------------------------------------------------------
// syncEdgeFromFormField
// ---------------------------------------------------------------------------

describe('syncEdgeFromFormField', () => {
  test('prev empty + next non-empty → append edge', () => {
    const def = makeDef({ nodes: [agent('a'), review('r')], edges: [] })
    const next = syncEdgeFromFormField(
      def,
      { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
      { nodeId: '', portName: '' },
      { nodeId: 'a', portName: 'design' },
    )
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'design' })
    expect(next.edges[0]!.target).toEqual({ nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID })
  })

  test('prev non-empty + next empty → drop matching edge', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a'), review('r')], edges: [edge] })
    const next = syncEdgeFromFormField(
      def,
      { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
      { nodeId: 'a', portName: 'design' },
      { nodeId: '', portName: '' },
    )
    expect(next.edges).toHaveLength(0)
  })

  test('prev non-empty + next different → replace edge', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a'), agent('b'), review('r')], edges: [edge] })
    const next = syncEdgeFromFormField(
      def,
      { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
      { nodeId: 'a', portName: 'design' },
      { nodeId: 'b', portName: 'spec' },
    )
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]!.source).toEqual({ nodeId: 'b', portName: 'spec' })
  })

  test('prev === next → ref-equal short-circuit', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({ nodes: [agent('a'), review('r')], edges: [edge] })
    const next = syncEdgeFromFormField(
      def,
      { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
      { nodeId: 'a', portName: 'design' },
      { nodeId: 'a', portName: 'design' },
    )
    expect(next).toBe(def)
  })
})

// ---------------------------------------------------------------------------
// healFieldEdgeConsistency
// ---------------------------------------------------------------------------

describe('healFieldEdgeConsistency', () => {
  test('review has inputSource but no matching edge → edge appended', () => {
    const def = makeDef({
      nodes: [agent('a'), review('r', { nodeId: 'a', portName: 'design' })],
      edges: [],
    })
    const next = healFieldEdgeConsistency(def)
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]!.target).toEqual({ nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID })
    expect(next.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'design' })
  })

  test('output port has bind but no matching edge → edge appended', () => {
    const def = makeDef({
      nodes: [agent('a'), output('o', [{ name: 'final', bind: { nodeId: 'a', portName: 'd' } }])],
      edges: [],
    })
    const next = healFieldEdgeConsistency(def)
    expect(next.edges).toHaveLength(1)
    expect(next.edges[0]!.target).toEqual({ nodeId: 'o', portName: 'final' })
    expect(next.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'd' })
  })

  test('YAML import path: edge exists but field is empty → field written', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({
      nodes: [agent('a'), review('r', { nodeId: '', portName: '' })],
      edges: [edge],
    })
    const next = healFieldEdgeConsistency(def)
    const r = next.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: 'a', portName: 'design' })
  })

  test('field and edge agree → ref-equal short-circuit', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'a', portName: 'design' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({
      nodes: [agent('a'), review('r', { nodeId: 'a', portName: 'design' })],
      edges: [edge],
    })
    expect(healFieldEdgeConsistency(def)).toBe(def)
  })

  test('field and edge disagree → edge wins (field rewritten)', () => {
    const edge: WorkflowEdge = {
      id: 'e1',
      source: { nodeId: 'b', portName: 'spec' },
      target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
    }
    const def = makeDef({
      nodes: [agent('a'), agent('b'), review('r', { nodeId: 'a', portName: 'design' })],
      edges: [edge],
    })
    const next = healFieldEdgeConsistency(def)
    const r = next.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: 'b', portName: 'spec' })
    // edge count unchanged — we did not append; only rewrote the field.
    expect(next.edges).toHaveLength(1)
  })
})
