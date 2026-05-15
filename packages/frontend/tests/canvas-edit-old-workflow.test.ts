// RFC-004 — opening an old workflow (input node present, `inputs: []` empty)
// must heal `definition.inputs[]` on load so the next auto-save writes the
// corrected shape back to the daemon. No backend migration runs.
//
// RFC-007 extension: the same heal pass also reconciles
// `review.inputSource` / `output.ports[].bind` with `definition.edges[]`.
// Pre-RFC-007 workflows that authored these only through the form lacked
// the visual edge on canvas; opening once materializes the edge. YAML
// imports that authored edges directly (no field value) self-correct in
// the reverse direction.
//
// If this goes red, check workflows.edit.tsx's load-from-query useEffect AND
// healLoadedDefinition + connectionSync.healFieldEdgeConsistency.

import type { WorkflowDefinition, WorkflowNode } from '@agent-workflow/shared'
import { describe, expect, test } from 'vitest'
import { healLoadedDefinition } from '../src/routes/workflows.edit'
import { REVIEW_INPUT_HANDLE_ID } from '../src/components/canvas/connectionSync'

describe('healLoadedDefinition (RFC-004)', () => {
  test('old shape: inputs:[] + input node with inputKey → inputs[] populated', () => {
    const old: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' } as WorkflowNode],
      edges: [],
    }
    const healed = healLoadedDefinition(old)
    expect(healed).not.toBe(old)
    expect(healed.inputs).toHaveLength(1)
    expect(healed.inputs[0]?.key).toBe('requirement')
    expect(healed.inputs[0]?.kind).toBe('text')
    expect(healed.inputs[0]?.required).toBe(true)
  })

  test('clean shape (inputs[] already matches) returns the same reference', () => {
    const clean: WorkflowDefinition = {
      $schema_version: 1,
      inputs: [{ kind: 'text', key: 'requirement', label: 'requirement', required: true }],
      nodes: [{ id: 'i1', kind: 'input', inputKey: 'requirement' } as WorkflowNode],
      edges: [],
    }
    expect(healLoadedDefinition(clean)).toBe(clean)
  })
})

describe('healLoadedDefinition (RFC-007 review/output field ↔ edge heal)', () => {
  test('review.inputSource set but no edge → edge materialized', () => {
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'r',
          kind: 'review',
          inputSource: { nodeId: 'a', portName: 'design' },
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const healed = healLoadedDefinition(def)
    expect(healed.edges).toHaveLength(1)
    expect(healed.edges[0]!.target.nodeId).toBe('r')
    expect(healed.edges[0]!.target.portName).toBe(REVIEW_INPUT_HANDLE_ID)
    expect(healed.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'design' })
  })

  test('output port.bind set but no edge → edge materialized', () => {
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'o',
          kind: 'output',
          ports: [{ name: 'final_doc', bind: { nodeId: 'a', portName: 'design' } }],
        } as unknown as WorkflowNode,
      ],
      edges: [],
    }
    const healed = healLoadedDefinition(def)
    expect(healed.edges).toHaveLength(1)
    expect(healed.edges[0]!.target).toEqual({ nodeId: 'o', portName: 'final_doc' })
    expect(healed.edges[0]!.source).toEqual({ nodeId: 'a', portName: 'design' })
  })

  test('YAML import: edge exists but review.inputSource is empty → field written', () => {
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'r',
          kind: 'review',
          inputSource: { nodeId: '', portName: '' },
        } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'design' },
          target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
        },
      ],
    }
    const healed = healLoadedDefinition(def)
    const r = healed.nodes.find((n) => n.id === 'r')! as unknown as {
      inputSource: { nodeId: string; portName: string }
    }
    expect(r.inputSource).toEqual({ nodeId: 'a', portName: 'design' })
    // No extra edge added.
    expect(healed.edges).toHaveLength(1)
  })

  test('field + edge already consistent (review) → ref-equal short-circuit', () => {
    const def: WorkflowDefinition = {
      $schema_version: 2,
      inputs: [],
      nodes: [
        { id: 'a', kind: 'agent-single', agentName: 'stub' } as unknown as WorkflowNode,
        {
          id: 'r',
          kind: 'review',
          inputSource: { nodeId: 'a', portName: 'design' },
        } as unknown as WorkflowNode,
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'a', portName: 'design' },
          target: { nodeId: 'r', portName: REVIEW_INPUT_HANDLE_ID },
        },
      ],
    }
    expect(healLoadedDefinition(def)).toBe(def)
  })
})
