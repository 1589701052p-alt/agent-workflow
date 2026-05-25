// RFC-023 PR-C T16 — clarifyDragHelper pure-fn contract.
//
// Locks the reverse-drag interaction's three primitives:
//   - buildClarifyEdges always returns exactly two edges in (ask, ans)
//     order, on the four fixed system ports.
//   - isValidClarifyTarget accepts agent-{single,multi} only.
//   - hasExistingClarifyChannel detects the prior wiring before the second
//     drop fires (prevents the validator-level
//     `clarify-multiple-clarify-on-same-agent` from being the only line of
//     defense).
//   - applyClarifyReverseDrag is reference-stable on invalid drops + appends
//     both edges atomically on valid drops.
//   - clearClarifyEdgesForRemovedNodes cascades on node delete.

import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition, WorkflowEdge, WorkflowNode } from '@agent-workflow/shared'
import {
  applyClarifyReverseDrag,
  buildClarifyEdges,
  cascadeRemoveClarifyChannel,
  clarifyHasAttachedAgent,
  classifyClarifyConnection,
  CLARIFY_INPUT_PORT_NAME,
  CLARIFY_OUTPUT_PORT_NAME,
  CLARIFY_RESPONSE_TARGET_PORT_NAME,
  CLARIFY_SOURCE_PORT_NAME,
  clearClarifyEdgesForRemovedNodes,
  describeClarifyChannelEdge,
  hasExistingClarifyChannel,
  isValidClarifyTarget,
} from '../src/components/canvas/clarifyDragHelper'

function node(
  partial: Partial<WorkflowNode> & { id: string; kind: WorkflowNode['kind'] },
): WorkflowNode {
  return { ...partial } as WorkflowNode
}

function defOf(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): WorkflowDefinition {
  return {
    $schema_version: 3,
    inputs: [],
    nodes,
    edges,
    outputs: [],
  }
}

describe('buildClarifyEdges', () => {
  it('returns exactly two edges with the four system port names in (ask, ans) order', () => {
    const [ask, ans] = buildClarifyEdges('agent_designer', 'clarify_pick_db')
    expect(ask.source).toEqual({ nodeId: 'agent_designer', portName: CLARIFY_SOURCE_PORT_NAME })
    expect(ask.target).toEqual({ nodeId: 'clarify_pick_db', portName: CLARIFY_INPUT_PORT_NAME })
    expect(ans.source).toEqual({ nodeId: 'clarify_pick_db', portName: CLARIFY_OUTPUT_PORT_NAME })
    expect(ans.target).toEqual({
      nodeId: 'agent_designer',
      portName: CLARIFY_RESPONSE_TARGET_PORT_NAME,
    })
    // Distinct ids so xyflow doesn't dedupe one.
    expect(ask.id).not.toBe(ans.id)
    expect(ask.id.endsWith('_ask')).toBe(true)
    expect(ans.id.endsWith('_ans')).toBe(true)
  })
})

describe('isValidClarifyTarget', () => {
  it('accepts agent-single only (RFC-060 PR-E removed agent-multi)', () => {
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'agent-single' }))).toBe(true)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'review' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'output' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'input' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'wrapper-git' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'wrapper-loop' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'wrapper-fanout' }))).toBe(false)
    expect(isValidClarifyTarget(node({ id: 'a', kind: 'clarify' }))).toBe(false)
    expect(isValidClarifyTarget(undefined)).toBe(false)
  })
})

describe('hasExistingClarifyChannel', () => {
  it('detects an existing __clarify__ outbound edge on the agent', () => {
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      [
        {
          id: 'pre',
          source: { nodeId: 'a', portName: CLARIFY_SOURCE_PORT_NAME },
          target: { nodeId: 'c', portName: CLARIFY_INPUT_PORT_NAME },
        },
      ],
    )
    expect(hasExistingClarifyChannel(def, 'a')).toBe(true)
    expect(hasExistingClarifyChannel(def, 'b')).toBe(false)
    expect(hasExistingClarifyChannel(defOf([]), 'a')).toBe(false)
  })
})

describe('applyClarifyReverseDrag', () => {
  it('appends both edges on a valid drop onto agent-single', () => {
    const def = defOf([node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })])
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'a',
      clarifyNodeId: 'c',
    })
    expect(next).not.toBe(def)
    expect(next.edges.length).toBe(2)
    expect(
      next.edges.some(
        (e) =>
          e.source.portName === CLARIFY_SOURCE_PORT_NAME &&
          e.target.portName === CLARIFY_INPUT_PORT_NAME,
      ),
    ).toBe(true)
    expect(
      next.edges.some(
        (e) =>
          e.source.portName === CLARIFY_OUTPUT_PORT_NAME &&
          e.target.portName === CLARIFY_RESPONSE_TARGET_PORT_NAME,
      ),
    ).toBe(true)
  })

  it('rejects (returns by ref) when the agent already has a clarify channel', () => {
    const def = defOf(
      [
        node({ id: 'a', kind: 'agent-single' }),
        node({ id: 'c1', kind: 'clarify' }),
        node({ id: 'c2', kind: 'clarify' }),
      ],
      [
        {
          id: 'pre',
          source: { nodeId: 'a', portName: CLARIFY_SOURCE_PORT_NAME },
          target: { nodeId: 'c1', portName: CLARIFY_INPUT_PORT_NAME },
        },
      ],
    )
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'a',
      clarifyNodeId: 'c2',
    })
    expect(next).toBe(def)
  })

  it('rejects (returns by ref) when the source is not an agent', () => {
    const def = defOf([node({ id: 'r', kind: 'review' }), node({ id: 'c', kind: 'clarify' })])
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'r',
      clarifyNodeId: 'c',
    })
    expect(next).toBe(def)
  })

  // RFC-063 — one clarify node may only attach to one agent. The second
  // reverse-drag onto a DIFFERENT agent must short-circuit instead of
  // appending a second pair of edges; the validator's
  // `clarify-multiple-source-agents` rule catches the saved state, but the
  // canvas should never let the user draw the bad state in the first place.
  it('rejects (returns by ref) when the clarify node already has another agent attached (RFC-063)', () => {
    const def = defOf(
      [
        node({ id: 'a1', kind: 'agent-single' }),
        node({ id: 'a2', kind: 'agent-single' }),
        node({ id: 'c', kind: 'clarify' }),
      ],
      [
        // a1 already attached to c via the standard ask edge
        {
          id: 'pre_ask',
          source: { nodeId: 'a1', portName: CLARIFY_SOURCE_PORT_NAME },
          target: { nodeId: 'c', portName: CLARIFY_INPUT_PORT_NAME },
        },
      ],
    )
    const next = applyClarifyReverseDrag(def, {
      sourceAgentNodeId: 'a2',
      clarifyNodeId: 'c',
    })
    expect(next).toBe(def)
  })

  // RFC-060 PR-E: agent-multi removed; the prior "agent-multi → clarify
  // reverse-drag accepted" case is no longer applicable. agent-single drag
  // is covered by the test above.
})

describe('clarifyHasAttachedAgent (RFC-063)', () => {
  it('detects an existing __clarify__ → questions inbound edge on the clarify node', () => {
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      [
        {
          id: 'pre',
          source: { nodeId: 'a', portName: CLARIFY_SOURCE_PORT_NAME },
          target: { nodeId: 'c', portName: CLARIFY_INPUT_PORT_NAME },
        },
      ],
    )
    expect(clarifyHasAttachedAgent(def, 'c')).toBe(true)
    expect(clarifyHasAttachedAgent(def, 'other')).toBe(false)
    expect(clarifyHasAttachedAgent(defOf([]), 'c')).toBe(false)
  })

  it('does not count answer-channel-only edges as attachment', () => {
    // Edge with answer-channel ports but no ask-channel inbound → clarify
    // is not actually "attached" to an agent in the canvas sense.
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      [
        {
          id: 'ans_only',
          source: { nodeId: 'c', portName: CLARIFY_OUTPUT_PORT_NAME },
          target: { nodeId: 'a', portName: CLARIFY_RESPONSE_TARGET_PORT_NAME },
        },
      ],
    )
    expect(clarifyHasAttachedAgent(def, 'c')).toBe(false)
  })
})

describe('classifyClarifyConnection (RFC-023 bugfix #2)', () => {
  function defWithBoth(): WorkflowDefinition {
    return defOf([
      node({ id: 'agent', kind: 'agent-single' }),
      node({ id: 'clar', kind: 'clarify' }),
    ])
  }

  it('classifies a reverse drag (target=clarify.questions) with the right pair', () => {
    const out = classifyClarifyConnection(defWithBoth(), {
      source: 'agent',
      target: 'clar',
      sourceHandle: 'whatever_output_port',
      targetHandle: CLARIFY_INPUT_PORT_NAME,
    })
    expect(out).toEqual({
      sourceAgentNodeId: 'agent',
      clarifyNodeId: 'clar',
      direction: 'reverse',
    })
  })

  it('classifies a forward drag (source=clarify.answers) with the right pair', () => {
    const out = classifyClarifyConnection(defWithBoth(), {
      source: 'clar',
      target: 'agent',
      sourceHandle: CLARIFY_OUTPUT_PORT_NAME,
      targetHandle: 'requirement', // arbitrary agent input
    })
    expect(out).toEqual({
      sourceAgentNodeId: 'agent',
      clarifyNodeId: 'clar',
      direction: 'forward',
    })
  })

  it('returns null for a non-clarify drop (caller falls through to normal edge creation)', () => {
    const out = classifyClarifyConnection(defWithBoth(), {
      source: 'agent',
      target: 'clar',
      sourceHandle: 'something',
      targetHandle: 'something_else',
    })
    expect(out).toBeNull()
  })

  it('returns null when the would-be clarify target/source node is missing or wrong kind', () => {
    const out = classifyClarifyConnection(defWithBoth(), {
      source: 'agent',
      target: 'nonexistent',
      sourceHandle: 'x',
      targetHandle: CLARIFY_INPUT_PORT_NAME,
    })
    expect(out).toBeNull()
    const out2 = classifyClarifyConnection(defWithBoth(), {
      source: 'agent', // not a clarify node
      target: 'clar',
      sourceHandle: CLARIFY_OUTPUT_PORT_NAME,
      targetHandle: 'x',
    })
    expect(out2).toBeNull()
  })
})

describe('describeClarifyChannelEdge', () => {
  it('classifies the ask edge as "ask" half with correct (agent, clarify) pair', () => {
    const [ask] = buildClarifyEdges('a', 'c')
    const desc = describeClarifyChannelEdge(ask)
    expect(desc).toEqual({ agentNodeId: 'a', clarifyNodeId: 'c', half: 'ask' })
  })

  it('classifies the ans edge as "ans" half with correct (agent, clarify) pair', () => {
    const [, ans] = buildClarifyEdges('a', 'c')
    const desc = describeClarifyChannelEdge(ans)
    expect(desc).toEqual({ agentNodeId: 'a', clarifyNodeId: 'c', half: 'ans' })
  })

  it('returns null for unrelated edges', () => {
    const e: WorkflowEdge = {
      id: 'x',
      source: { nodeId: 'in', portName: 'requirement' },
      target: { nodeId: 'a', portName: 'requirement' },
    }
    expect(describeClarifyChannelEdge(e)).toBeNull()
  })
})

describe('cascadeRemoveClarifyChannel (RFC-023 bugfix #3)', () => {
  it('drops the sibling edge when the ans edge is removed alone', () => {
    const [ask, ans] = buildClarifyEdges('a', 'c')
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      [ask, ans],
    )
    // Simulate xyflow's "user pressed delete on the answer edge" path: the
    // ans edge is gone from def.edges but ask is still in it. Cascade
    // should then drop ask too.
    const afterDelete: WorkflowDefinition = { ...def, edges: [ask] }
    const next = cascadeRemoveClarifyChannel(afterDelete, [ans])
    expect(next.edges.length).toBe(0)
  })

  it('drops the sibling edge when the ask edge is removed alone', () => {
    const [ask, ans] = buildClarifyEdges('a', 'c')
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      [ask, ans],
    )
    const afterDelete: WorkflowDefinition = { ...def, edges: [ans] }
    const next = cascadeRemoveClarifyChannel(afterDelete, [ask])
    expect(next.edges.length).toBe(0)
  })

  it('is a no-op (returns by ref) when no clarify edges were removed', () => {
    const [ask, ans] = buildClarifyEdges('a', 'c')
    const otherEdge: WorkflowEdge = {
      id: 'other',
      source: { nodeId: 'in', portName: 'requirement' },
      target: { nodeId: 'a', portName: 'requirement' },
    }
    const def = defOf(
      [
        node({ id: 'in', kind: 'input' }),
        node({ id: 'a', kind: 'agent-single' }),
        node({ id: 'c', kind: 'clarify' }),
      ],
      [otherEdge, ask, ans],
    )
    const afterDelete: WorkflowDefinition = { ...def, edges: [ask, ans] }
    expect(cascadeRemoveClarifyChannel(afterDelete, [otherEdge])).toBe(afterDelete)
  })

  it('preserves unrelated clarify channels when one channel is deleted', () => {
    const [askA, ansA] = buildClarifyEdges('agentA', 'clarA')
    const [askB, ansB] = buildClarifyEdges('agentB', 'clarB')
    const def = defOf(
      [
        node({ id: 'agentA', kind: 'agent-single' }),
        node({ id: 'agentB', kind: 'agent-single' }),
        node({ id: 'clarA', kind: 'clarify' }),
        node({ id: 'clarB', kind: 'clarify' }),
      ],
      [askA, ansA, askB, ansB],
    )
    const afterDelete: WorkflowDefinition = { ...def, edges: [askA, askB, ansB] }
    const next = cascadeRemoveClarifyChannel(afterDelete, [ansA])
    expect(next.edges.map((e) => e.id).sort()).toEqual([askB.id, ansB.id].sort())
  })
})

describe('clearClarifyEdgesForRemovedNodes', () => {
  it('removes clarify channel edges that reference a removed node id', () => {
    const def = defOf(
      [node({ id: 'a', kind: 'agent-single' }), node({ id: 'c', kind: 'clarify' })],
      buildClarifyEdges('a', 'c'),
    )
    const next = clearClarifyEdgesForRemovedNodes(def, ['c'])
    expect(next).not.toBe(def)
    expect(next.edges.length).toBe(0)
  })

  it('returns by ref when no clarify edges were affected', () => {
    const def = defOf([node({ id: 'a', kind: 'agent-single' })], [])
    expect(clearClarifyEdgesForRemovedNodes(def, ['a'])).toBe(def)
    expect(clearClarifyEdgesForRemovedNodes(def, [])).toBe(def)
  })

  it('preserves non-clarify edges that reference the removed node', () => {
    const otherEdge: WorkflowEdge = {
      id: 'other',
      source: { nodeId: 'in', portName: 'requirement' },
      target: { nodeId: 'a', portName: 'requirement' },
    }
    const def = defOf(
      [
        node({ id: 'in', kind: 'input' }),
        node({ id: 'a', kind: 'agent-single' }),
        node({ id: 'c', kind: 'clarify' }),
      ],
      [otherEdge, ...buildClarifyEdges('a', 'c')],
    )
    // Removing the clarify node should drop only the two clarify edges, not 'other'.
    const next = clearClarifyEdgesForRemovedNodes(def, ['c'])
    expect(next.edges.length).toBe(1)
    expect(next.edges[0]?.id).toBe('other')
  })
})
