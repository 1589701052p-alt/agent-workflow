// RFC-016 §5.1: loopMemberCandidates feeds the loop wrapper Inspector
// nodeId / portName selects. The reason these are pure-fn tested rather
// than rendered: candidate derivation has to track wrapper.nodeIds changes
// reactively in the inspector, and the source of truth is the function.

import { describe, expect, test } from 'vitest'
import type { WorkflowNode } from '@agent-workflow/shared'
import { loopMemberCandidates } from '../src/components/canvas/wrapperCandidates'

function loop(id: string, nodeIds: string[]): WorkflowNode {
  return { id, kind: 'wrapper-loop', position: { x: 0, y: 0 }, nodeIds } as unknown as WorkflowNode
}
function agent(id: string, agentName: string): WorkflowNode {
  return {
    id,
    kind: 'agent-single',
    position: { x: 0, y: 0 },
    agentName,
  } as unknown as WorkflowNode
}
function review(id: string, sourcePort: string): WorkflowNode {
  return {
    id,
    kind: 'review',
    position: { x: 0, y: 0 },
    source: { nodeId: 'upstream', portName: sourcePort },
  } as unknown as WorkflowNode
}
function gitWrap(id: string, nodeIds: string[]): WorkflowNode {
  return { id, kind: 'wrapper-git', position: { x: 0, y: 0 }, nodeIds } as unknown as WorkflowNode
}

describe('loopMemberCandidates', () => {
  test('agent node candidates carry declared outputs', () => {
    const l = loop('loop1', ['a1'])
    const a = agent('a1', 'fixer')
    const out = loopMemberCandidates(l, [l, a], [{ name: 'fixer', outputs: ['passed', 'issues'] }])
    expect(out).toEqual([{ nodeId: 'a1', title: 'fixer', outputPorts: ['passed', 'issues'] }])
  })

  test('review node candidates use the fixed `output` port and review:port title', () => {
    const l = loop('loop1', ['r1'])
    const r = review('r1', 'design')
    const out = loopMemberCandidates(l, [l, r], [])
    expect(out).toEqual([{ nodeId: 'r1', title: 'review:design', outputPorts: ['output'] }])
  })

  test('nested wrapper inner nodes are excluded from candidate list', () => {
    const l = loop('loop1', ['a1', 'inner_git'])
    const a = agent('a1', 'fixer')
    const inner = gitWrap('inner_git', ['a2'])
    const a2 = agent('a2', 'helper')
    const out = loopMemberCandidates(
      l,
      [l, a, inner, a2],
      [
        { name: 'fixer', outputs: ['passed'] },
        { name: 'helper', outputs: ['done'] },
      ],
    )
    expect(out.map((c) => c.nodeId)).toEqual(['a1'])
  })

  test('agent without declared outputs falls back to [out]', () => {
    const l = loop('loop1', ['a1'])
    const a = agent('a1', 'unknown_agent')
    const out = loopMemberCandidates(l, [l, a], [])
    expect(out).toEqual([{ nodeId: 'a1', title: 'unknown_agent', outputPorts: ['out'] }])
  })
})
