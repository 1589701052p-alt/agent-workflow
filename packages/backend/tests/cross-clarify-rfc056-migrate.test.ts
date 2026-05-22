// RFC-056 — v3 → v4 transparent workflow $schema_version upgrade.
//
// LOCKS: pure metadata bump. v3 docs (RFC-023 era) walk to v4 with shape
// untouched. Stored definition stays at original version until next PUT —
// same heal-on-edit pattern as the v1 → v2 and v2 → v3 bumps before us.

import type { WorkflowDefinition } from '@agent-workflow/shared'
import { WORKFLOW_SCHEMA_VERSION } from '@agent-workflow/shared'
import { describe, expect, test } from 'bun:test'

import { migrateDefinitionToLatest } from '../src/services/workflow'

describe('RFC-056 — v3 → v4 transparent upgrade (no cross-clarify node yet)', () => {
  test('v3 doc with RFC-023 clarify node walks to v4 with shape preserved', () => {
    const v3: WorkflowDefinition = {
      $schema_version: 3,
      inputs: [{ kind: 'text', key: 'spec', label: 'spec' }],
      nodes: [
        { id: 'i1', kind: 'input', inputKey: 'spec' },
        { id: 'a1', kind: 'agent-single', agentName: 'designer' },
        { id: 'c1', kind: 'clarify', title: 'Self-clarify' },
      ],
      edges: [
        {
          id: 'e1',
          source: { nodeId: 'i1', portName: 'spec' },
          target: { nodeId: 'a1', portName: 'spec' },
        },
        {
          id: 'e2',
          source: { nodeId: 'a1', portName: '__clarify__' },
          target: { nodeId: 'c1', portName: 'questions' },
        },
        {
          id: 'e3',
          source: { nodeId: 'c1', portName: 'answers' },
          target: { nodeId: 'a1', portName: '__clarify_response__' },
        },
      ],
    }
    const out = migrateDefinitionToLatest(v3)
    expect(out.$schema_version).toBe(WORKFLOW_SCHEMA_VERSION)
    expect(out.$schema_version).toBe(4)
    expect(out.nodes).toEqual(v3.nodes)
    expect(out.edges).toEqual(v3.edges)
    expect(out.inputs).toEqual(v3.inputs)
    // input untouched
    expect(v3.$schema_version).toBe(3)
  })

  test('v4 doc with cross-clarify node is identity (already-latest, no mutation)', () => {
    const v4: WorkflowDefinition = {
      $schema_version: 4,
      inputs: [],
      nodes: [
        { id: 'd1', kind: 'agent-single', agentName: 'designer' },
        { id: 'q1', kind: 'agent-single', agentName: 'questioner' },
        {
          id: 'cc1',
          kind: 'clarify-cross-agent',
          title: 'Cross feedback',
          sessionModeForDesigner: 'inline',
          sessionModeForQuestioner: 'isolated',
        },
      ],
      edges: [],
    }
    const out = migrateDefinitionToLatest(v4)
    expect(out.$schema_version).toBe(4)
    expect(out.nodes).toEqual(v4.nodes)
  })
})
