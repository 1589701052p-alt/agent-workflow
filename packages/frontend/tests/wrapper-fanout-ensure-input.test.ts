// 2026-05-24 regression lock — ensureWrapperFanoutInputForEdge keeps the
// wrapper-fanout `inputs[]` list as the single source of truth.
//
// User feedback after the first fanout drag-connect ship: "入边和输入端口
// 应该同源才对，没必要分成 2 类" — i.e. don't surface inbound edges as a
// separate inspector panel; reconcile the inputs[] list so every wired
// port is also a declared input. Without this reconciliation, a drag-
// connected edge created a "phantom" port — visible on the canvas, missing
// from the inspector's Inputs section, and a validator trip waiting to
// happen on next save.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition, WorkflowEdge } from '@agent-workflow/shared'
import { ensureWrapperFanoutInputForEdge } from '../src/components/canvas/WorkflowCanvas'

function defWith(nodes: WorkflowDefinition['nodes']): WorkflowDefinition {
  return { $schema_version: 2, inputs: [], nodes, edges: [] } as WorkflowDefinition
}

function fanout(
  id: string,
  inputs: Array<{ name: string; kind: string; isShardSource?: boolean }>,
) {
  return {
    id,
    kind: 'wrapper-fanout',
    position: { x: 0, y: 0 },
    nodeIds: [],
    inputs,
  } as unknown as WorkflowDefinition['nodes'][number]
}

function edge(id: string, target: { nodeId: string; portName: string }): WorkflowEdge {
  return {
    id,
    source: { nodeId: 'src', portName: 'out' },
    target,
  }
}

describe('ensureWrapperFanoutInputForEdge', () => {
  test('no-op when the target port is already declared', () => {
    const prev = defWith([
      fanout('w1', [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }]),
    ])
    const out = ensureWrapperFanoutInputForEdge(
      prev,
      edge('e1', { nodeId: 'w1', portName: 'docs' }),
    )
    // Same reference — short-circuit so React effects skip work.
    expect(out).toBe(prev)
  })

  test('appends an undeclared port as the shardSource when none exists', () => {
    const prev = defWith([fanout('w1', [])])
    const out = ensureWrapperFanoutInputForEdge(
      prev,
      edge('e1', { nodeId: 'w1', portName: 'git_diff' }),
    )
    expect(out).not.toBe(prev)
    const wrapper = out.nodes.find((n) => n.id === 'w1') as unknown as {
      inputs: Array<{ name: string; kind: string; isShardSource?: boolean }>
    }
    expect(wrapper.inputs).toEqual([
      { name: 'git_diff', kind: 'list<string>', isShardSource: true },
    ])
  })

  test('appends as a broadcast (non-shard) port when shardSource already exists', () => {
    const prev = defWith([
      fanout('w1', [{ name: 'docs', kind: 'list<path<md>>', isShardSource: true }]),
    ])
    const out = ensureWrapperFanoutInputForEdge(
      prev,
      edge('e1', { nodeId: 'w1', portName: 'config' }),
    )
    const wrapper = out.nodes.find((n) => n.id === 'w1') as unknown as {
      inputs: Array<{ name: string; kind: string; isShardSource?: boolean }>
    }
    expect(wrapper.inputs.length).toBe(2)
    expect(wrapper.inputs[1]).toEqual({ name: 'config', kind: 'string' })
    // shardSource singleton invariant preserved.
    expect(wrapper.inputs.filter((p) => p.isShardSource === true).length).toBe(1)
  })

  test('no-op when the target is not a wrapper-fanout', () => {
    const prev: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        {
          id: 'a1',
          kind: 'agent-single',
          position: { x: 0, y: 0 },
          agentName: 'doc',
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    }
    const out = ensureWrapperFanoutInputForEdge(
      prev,
      edge('e1', { nodeId: 'a1', portName: 'whatever' }),
    )
    expect(out).toBe(prev)
  })
})
