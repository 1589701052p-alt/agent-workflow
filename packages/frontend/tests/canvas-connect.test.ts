// translateInboundConnection — RFC-003 catch-all → named-handle adapter.
//
// We cover this in isolation rather than mounting a full WorkflowCanvas
// because xyflow's onConnect has a lot of moving parts; the translation
// itself is the only new behavior.

import { describe, expect, test } from 'vitest'
import {
  buildEdgeFromConnection,
  deriveSelection,
  selectionSig,
  translateInboundConnection,
} from '../src/components/canvas/WorkflowCanvas'
import { INBOUND_HANDLE_ID } from '../src/components/canvas/nodes/types'
import type { WorkflowDefinition } from '@agent-workflow/shared'

const DEF: WorkflowDefinition = {
  $schema_version: 1,
  inputs: [],
  nodes: [],
  edges: [
    {
      id: 'existing',
      source: { nodeId: 'a', portName: 'out' },
      target: { nodeId: 'b', portName: 'out' },
    },
  ],
}

describe('translateInboundConnection', () => {
  test('catch-all targetHandle → uses sourceHandle as targetHandle', () => {
    const out = translateInboundConnection({
      source: 'a',
      target: 'b',
      sourceHandle: 'requirement',
      targetHandle: INBOUND_HANDLE_ID,
    })
    expect(out.targetHandle).toBe('requirement')
    expect(out.sourceHandle).toBe('requirement')
  })

  test('named targetHandle → passes through unchanged', () => {
    const out = translateInboundConnection({
      source: 'a',
      target: 'b',
      sourceHandle: 'out',
      targetHandle: 'foo',
    })
    expect(out.targetHandle).toBe('foo')
  })

  test('catch-all + null sourceHandle → targetHandle stays null (caller rejects)', () => {
    const out = translateInboundConnection({
      source: 'a',
      target: 'b',
      sourceHandle: null,
      targetHandle: INBOUND_HANDLE_ID,
    })
    expect(out.targetHandle).toBeNull()
  })
})

describe('translate + buildEdgeFromConnection (full inbound flow)', () => {
  test('catch-all drop creates edge with target.portName === source.portName', () => {
    const conn = translateInboundConnection({
      source: 'a',
      target: 'c',
      sourceHandle: 'requirement',
      targetHandle: INBOUND_HANDLE_ID,
    })
    const built = buildEdgeFromConnection(DEF, conn)
    expect(built).not.toBeNull()
    expect(built?.target).toEqual({ nodeId: 'c', portName: 'requirement' })
  })

  test('catch-all drop landing on existing same-name edge is rejected (duplicate)', () => {
    const conn = translateInboundConnection({
      source: 'a',
      target: 'b',
      sourceHandle: 'out',
      targetHandle: INBOUND_HANDLE_ID,
    })
    expect(buildEdgeFromConnection(DEF, conn)).toBeNull()
  })

  test('catch-all drop with self-loop is rejected', () => {
    const conn = translateInboundConnection({
      source: 'a',
      target: 'a',
      sourceHandle: 'out',
      targetHandle: INBOUND_HANDLE_ID,
    })
    expect(buildEdgeFromConnection(DEF, conn)).toBeNull()
  })

  test('named-handle drop on a fresh port still works (fan-in into existing port)', () => {
    const conn = translateInboundConnection({
      source: 'a2',
      target: 'b',
      sourceHandle: 'whatever',
      targetHandle: 'out',
    })
    const built = buildEdgeFromConnection(DEF, conn)
    expect(built).not.toBeNull()
    expect(built?.target.portName).toBe('out')
  })
})

describe('deriveSelection', () => {
  test('exactly one node selected → kind=node', () => {
    expect(deriveSelection(['n1'], [])).toEqual({ kind: 'node', id: 'n1' })
  })

  test('exactly one edge selected → kind=edge', () => {
    expect(deriveSelection([], ['e1'])).toEqual({ kind: 'edge', id: 'e1' })
  })

  test('mixed / multi / empty selections → null (drawer collapses)', () => {
    expect(deriveSelection([], [])).toBeNull()
    expect(deriveSelection(['n1', 'n2'], [])).toBeNull()
    expect(deriveSelection([], ['e1', 'e2'])).toBeNull()
    expect(deriveSelection(['n1'], ['e1'])).toBeNull()
  })
})

// Regression: clicking a node tripped React's "Maximum update depth
// exceeded" because deriveSelection always returned a fresh object,
// parent re-rendered, xyflow's StoreUpdater re-fired onSelectionChange,
// and the loop never terminated. The dedupe in WorkflowCanvas keys off
// selectionSig — same-content selections collapse to the same string and
// the parent callback only fires when the signature changes.
describe('selectionSig (StoreUpdater loop guard)', () => {
  test('null selection has its own stable sig', () => {
    expect(selectionSig(null)).toBe('null')
  })

  test('same kind + id → same string regardless of object identity', () => {
    expect(selectionSig({ kind: 'node', id: 'n1' })).toBe('node:n1')
    expect(selectionSig({ kind: 'node', id: 'n1' })).toBe(selectionSig({ kind: 'node', id: 'n1' }))
  })

  test('different kind for same id → distinct sigs', () => {
    expect(selectionSig({ kind: 'node', id: 'x' })).not.toBe(
      selectionSig({ kind: 'edge', id: 'x' }),
    )
  })

  test('different ids → distinct sigs', () => {
    expect(selectionSig({ kind: 'node', id: 'a' })).not.toBe(
      selectionSig({ kind: 'node', id: 'b' }),
    )
  })
})
