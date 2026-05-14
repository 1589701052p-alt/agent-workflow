// buildEdgeFromConnection — wire format coverage for P-2-08.

import { describe, expect, test } from 'vitest'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { buildEdgeFromConnection } from '../src/components/canvas/WorkflowCanvas'

const DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [
    {
      id: 'existing',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'in' },
    },
  ],
}

describe('buildEdgeFromConnection', () => {
  test('valid connection becomes a WorkflowEdge with new id', () => {
    const e = buildEdgeFromConnection(DEF, {
      source: 'a',
      target: 'c',
      sourceHandle: 'out',
      targetHandle: 'something',
    })
    expect(e).not.toBeNull()
    expect(e?.source).toEqual({ nodeId: 'a', portName: 'out' })
    expect(e?.target).toEqual({ nodeId: 'c', portName: 'something' })
    expect(e?.id.startsWith('edge_')).toBe(true)
  })

  test('rejects missing handles', () => {
    expect(
      buildEdgeFromConnection(DEF, {
        source: 'a',
        target: 'b',
        sourceHandle: null,
        targetHandle: 'in',
      }),
    ).toBeNull()
    expect(
      buildEdgeFromConnection(DEF, {
        source: 'a',
        target: 'b',
        sourceHandle: 'out',
        targetHandle: null,
      }),
    ).toBeNull()
  })

  test('rejects missing source/target node', () => {
    expect(
      buildEdgeFromConnection(DEF, {
        source: null,
        target: 'b',
        sourceHandle: 'out',
        targetHandle: 'in',
      }),
    ).toBeNull()
  })

  test('rejects self-loops', () => {
    expect(
      buildEdgeFromConnection(DEF, {
        source: 'a',
        target: 'a',
        sourceHandle: 'out',
        targetHandle: 'in',
      }),
    ).toBeNull()
  })

  test('rejects duplicate edge with the same source+target port pair', () => {
    expect(
      buildEdgeFromConnection(DEF, {
        source: 'a',
        target: 'b',
        sourceHandle: 'out',
        targetHandle: 'in',
      }),
    ).toBeNull()
  })

  test('allows multiple edges with the same source but different target port', () => {
    const e = buildEdgeFromConnection(DEF, {
      source: 'a',
      target: 'b',
      sourceHandle: 'out',
      targetHandle: 'OTHER',
    })
    expect(e).not.toBeNull()
  })
})
