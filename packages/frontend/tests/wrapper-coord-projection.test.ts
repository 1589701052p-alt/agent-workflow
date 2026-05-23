// RFC-016 §3 + C5: DB schema stays absolute coordinates; only the xyflow
// render layer sees parentId + relative-to-parent positions. This test locks
// the projection round-trip: definition → xyflow (relative) → back to
// absolute must preserve the original positions exactly.

import { describe, expect, test } from 'vitest'
import type { Node } from '@xyflow/react'
import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import {
  buildParentMap,
  projectDefinitionForXyflow,
  projectXyflowPositionsToAbsolute,
  resolveWrappers,
  topoSortByParent,
} from '../src/components/canvas/coordProjection'

function def(nodes: WorkflowNode[]): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges: [] } as WorkflowDefinition
}
function wrap(
  id: string,
  kind: 'wrapper-git' | 'wrapper-loop',
  nodeIds: string[],
  extra: Record<string, unknown> = {},
): WorkflowNode {
  return {
    id,
    kind,
    position: extra.position ?? { x: 0, y: 0 },
    nodeIds,
    ...extra,
  } as unknown as WorkflowNode
}
function child(id: string, pos: { x: number; y: number }): WorkflowNode {
  return { id, kind: 'agent-single', position: pos, agentName: 'a' } as unknown as WorkflowNode
}
function flowNode(id: string, kind: string, pos: { x: number; y: number }): Node {
  return { id, type: kind, position: pos, data: {} } as Node
}

describe('coordProjection', () => {
  test('single wrapper with one child: child becomes relative-to-parent', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1'], {
        size: { width: 400, height: 300 },
        position: { x: 100, y: 100 },
      }),
      child('a1', { x: 200, y: 250 }),
    ])
    const flow: Node[] = [
      flowNode('w1', 'wrapper-git', { x: 100, y: 100 }),
      flowNode('a1', 'agent-single', { x: 200, y: 250 }),
    ]
    const projected = projectDefinitionForXyflow(d, flow)
    // Wrapper appears first (parent-before-child ordering)
    expect(projected[0]!.id).toBe('w1')
    const a1 = projected.find((n) => n.id === 'a1')!
    expect(a1.parentId).toBe('w1')
    // Intentionally NOT 'parent' — RFC-016 drag-out membership requires
    // children to be free to leave the wrapper rect during drag.
    expect(a1.extent).toBeUndefined()
    expect(a1.position).toEqual({ x: 100, y: 150 }) // 200-100, 250-100
  })

  test('projectXyflowPositionsToAbsolute inverts the relative projection', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1'], {
        size: { width: 400, height: 300 },
        position: { x: 100, y: 100 },
      }),
      child('a1', { x: 200, y: 250 }),
    ])
    const flow: Node[] = [
      flowNode('w1', 'wrapper-git', { x: 100, y: 100 }),
      flowNode('a1', 'agent-single', { x: 200, y: 250 }),
    ]
    const projected = projectDefinitionForXyflow(d, flow)
    const back = projectXyflowPositionsToAbsolute(d, projected)
    const a1 = back.find((n) => n.id === 'a1')!
    expect(a1.position).toEqual({ x: 200, y: 250 })
  })

  test('nested wrappers (git inside loop): child position relative to direct parent only', () => {
    const d = def([
      wrap('loop1', 'wrapper-loop', ['git1'], {
        size: { width: 800, height: 600 },
        position: { x: 0, y: 0 },
      }),
      wrap('git1', 'wrapper-git', ['a1'], {
        size: { width: 400, height: 300 },
        position: { x: 50, y: 50 },
      }),
      child('a1', { x: 150, y: 200 }),
    ])
    const flow: Node[] = [
      flowNode('loop1', 'wrapper-loop', { x: 0, y: 0 }),
      flowNode('git1', 'wrapper-git', { x: 50, y: 50 }),
      flowNode('a1', 'agent-single', { x: 150, y: 200 }),
    ]
    const projected = projectDefinitionForXyflow(d, flow)
    const git1 = projected.find((n) => n.id === 'git1')!
    const a1 = projected.find((n) => n.id === 'a1')!
    expect(git1.parentId).toBe('loop1')
    expect(git1.position).toEqual({ x: 50, y: 50 }) // relative to loop1 at (0,0)
    expect(a1.parentId).toBe('git1')
    expect(a1.position).toEqual({ x: 100, y: 150 }) // 150-50, 200-50
  })

  test('top-level nodes (no wrapper) have no parentId and absolute position', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1'], { size: { width: 400, height: 300 } }),
      child('a1', { x: 100, y: 100 }),
      child('a2', { x: 600, y: 100 }), // outside w1
    ])
    const flow: Node[] = [
      flowNode('w1', 'wrapper-git', { x: 0, y: 0 }),
      flowNode('a1', 'agent-single', { x: 100, y: 100 }),
      flowNode('a2', 'agent-single', { x: 600, y: 100 }),
    ]
    const projected = projectDefinitionForXyflow(d, flow)
    const a2 = projected.find((n) => n.id === 'a2')!
    expect(a2.parentId).toBeUndefined()
    expect(a2.position).toEqual({ x: 600, y: 100 })
  })

  test('wrapper without persisted size renders at computeFitBounds.offset', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1'], { position: { x: 999, y: 999 } }), // ignored when size absent
      child('a1', { x: 100, y: 100 }),
    ])
    const flow: Node[] = [
      flowNode('w1', 'wrapper-git', { x: 999, y: 999 }),
      flowNode('a1', 'agent-single', { x: 100, y: 100 }),
    ]
    const projected = projectDefinitionForXyflow(d, flow)
    const w1 = projected.find((n) => n.id === 'w1')!
    // Fit offset = (100 - padding=40 - handleSlack=16, 100 - 40 - header=22)
    // = (44, 38). Exact numbers tracked here to lock the projection contract;
    // changes to padding / handle slack need to update this expectation.
    expect(w1.position).toEqual({ x: 44, y: 38 })
    expect(w1.style?.width).toBeGreaterThan(0)
    expect(w1.style?.height).toBeGreaterThan(0)
  })

  test('topoSortByParent puts parent wrapper before its children', () => {
    const parentMap = new Map<string, string>([
      ['a1', 'w1'],
      ['a2', 'w1'],
      ['nested', 'w1'],
      ['na', 'nested'],
    ])
    const flow: Node[] = [
      flowNode('a1', 'agent-single', { x: 0, y: 0 }),
      flowNode('na', 'agent-single', { x: 0, y: 0 }),
      flowNode('nested', 'wrapper-git', { x: 0, y: 0 }),
      flowNode('a2', 'agent-single', { x: 0, y: 0 }),
      flowNode('w1', 'wrapper-loop', { x: 0, y: 0 }),
    ]
    const sorted = topoSortByParent(flow, parentMap)
    const orderIndex = (id: string) => sorted.findIndex((n) => n.id === id)
    expect(orderIndex('w1')).toBeLessThan(orderIndex('a1'))
    expect(orderIndex('w1')).toBeLessThan(orderIndex('a2'))
    expect(orderIndex('w1')).toBeLessThan(orderIndex('nested'))
    expect(orderIndex('nested')).toBeLessThan(orderIndex('na'))
  })

  // RFC-060 — wrapper-fanout must be a real wrapper from the projection
  // layer's POV. Locks in the 2026-05-24 bug: isWrapperKind() used to only
  // accept git/loop, so a freshly dragged-out wrapper-fanout never had
  // style.width/height stamped and rendered at intrinsic content size
  // (visibly smaller than its sibling wrapper kinds). If a regression
  // re-narrows isWrapperKind, the assertions below flip red.
  test('wrapper-fanout: projection stamps style.width/height like git/loop', () => {
    const d: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'fan1',
          kind: 'wrapper-fanout',
          position: { x: 200, y: 200 },
          nodeIds: [],
          inputs: [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }],
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const flow: Node[] = [flowNode('fan1', 'wrapper-fanout', { x: 200, y: 200 })]
    const projected = projectDefinitionForXyflow(d, flow)
    const fan = projected.find((n) => n.id === 'fan1')!
    expect(fan.style?.width).toBeGreaterThan(0)
    expect(fan.style?.height).toBeGreaterThan(0)
    // resolveWrappers must also see it — buildParentMap depends on it for
    // membership of inner nodes.
    const wrappers = resolveWrappers(d)
    expect(wrappers.has('fan1')).toBe(true)
  })

  test('resolveWrappers + buildParentMap: one node has exactly one parent', () => {
    const d = def([
      wrap('w1', 'wrapper-git', ['a1', 'a2'], { size: { width: 400, height: 300 } }),
      child('a1', { x: 0, y: 0 }),
      child('a2', { x: 0, y: 0 }),
    ])
    const wrappers = resolveWrappers(d)
    expect(wrappers.size).toBe(1)
    expect(wrappers.get('w1')?.innerIds).toEqual(['a1', 'a2'])
    const parentMap = buildParentMap(wrappers)
    expect(parentMap.get('a1')).toBe('w1')
    expect(parentMap.get('a2')).toBe('w1')
  })
})
