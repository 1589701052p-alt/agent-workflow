// 2026-05-24 regression lock — fanoutSourceSync was reduced to no-ops after
// RFC-060 PR-E removed agent-multi. `isValidSourcePortConnection` is wired into
// `WorkflowCanvas.isValidConnection` as a pass-guard:
//
//   if (!isValidSourcePortConnection(definition, guardConn)) return false
//
// i.e. **`false` from the function rejects the connection entirely**. The
// PR-E stub returned `false`, which silently invalidated EVERY drag-to-connect
// on the canvas — wrapper outputs (`git_diff`, `__done__`) and agent-to-agent
// edges alike. The connection line drew with `react-flow__connection invalid`
// (red dashed) and `onConnect` never fired.
//
// This test pins the corrected no-op semantics (`return true`) so a future
// rewrite can't silently re-invert and break canvas authoring again.

import { describe, expect, test } from 'vitest'
import type { Connection } from '@xyflow/react'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { isValidSourcePortConnection } from '../src/components/canvas/fanoutSourceSync'

const EMPTY_DEF: WorkflowDefinition = {
  $schema_version: 2,
  inputs: [],
  nodes: [],
  edges: [],
}

const ANY_CONN: Connection = {
  source: 'anyA',
  sourceHandle: 'out',
  target: 'anyB',
  targetHandle: '__inbound__',
}

describe('fanoutSourceSync no-op stubs (post-RFC-060 PR-E)', () => {
  test('isValidSourcePortConnection passes every connection through (returns true)', () => {
    // Caller convention: `if (!fn(...)) return false`. Returning true here
    // means "this guard has no opinion, let the connection through".
    expect(isValidSourcePortConnection(EMPTY_DEF, ANY_CONN)).toBe(true)
  })

  test('returns true even for wrapper output → agent drops (the user-reported case)', () => {
    const wrapperOutDrop: Connection = {
      source: 'wrap_git_1',
      sourceHandle: 'git_diff',
      target: 'agent_downstream',
      targetHandle: '__inbound__',
    }
    expect(isValidSourcePortConnection(EMPTY_DEF, wrapperOutDrop)).toBe(true)
  })

  test('returns true for the fanout `__done__` signal-port drop too', () => {
    const fanoutDoneDrop: Connection = {
      source: 'wrap_fan_1',
      sourceHandle: '__done__',
      target: 'agent_downstream',
      targetHandle: '__inbound__',
    }
    expect(isValidSourcePortConnection(EMPTY_DEF, fanoutDoneDrop)).toBe(true)
  })
})
