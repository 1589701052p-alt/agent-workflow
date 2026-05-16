// RFC-020 T5: workflow validator rejects malformed kind: 'upload' inputs.

import { describe, expect, test } from 'bun:test'
import type { WorkflowDefinition } from '@agent-workflow/shared'
import { validateWorkflowDef } from '../src/services/workflow.validator'

function defWithUpload(overrides: Record<string, unknown>): WorkflowDefinition {
  return {
    $schema_version: 2,
    inputs: [
      {
        kind: 'upload',
        key: 'refs',
        label: 'refs',
        ...overrides,
      } as unknown as WorkflowDefinition['inputs'][number],
    ],
    nodes: [
      { id: 'in_refs', kind: 'input', inputKey: 'refs' } as WorkflowDefinition['nodes'][number],
    ],
    edges: [],
  }
}

describe('validateWorkflowDef upload inputs (RFC-020)', () => {
  test('happy path: valid targetDir is accepted', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: 'inputs/refs' }), {
      agents: [],
      skills: [],
    })
    const codes = r.issues.map((i) => i.code)
    expect(codes).not.toContain('upload-input-target-dir-missing')
    expect(codes).not.toContain('upload-input-target-dir-invalid')
  })

  test('rejects missing targetDir', () => {
    const r = validateWorkflowDef(defWithUpload({}), { agents: [], skills: [] })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-missing')
    expect(issue).toBeDefined()
    expect(issue?.severity ?? 'error').toBe('error')
    expect(r.ok).toBe(false)
  })

  test('rejects targetDir with ".."', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: '../escape' }), {
      agents: [],
      skills: [],
    })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-invalid')
    expect(issue).toBeDefined()
    expect(r.ok).toBe(false)
  })

  test('rejects absolute targetDir', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: '/etc' }), {
      agents: [],
      skills: [],
    })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-invalid')
    expect(issue).toBeDefined()
  })

  test('rejects Windows drive-prefix targetDir', () => {
    const r = validateWorkflowDef(defWithUpload({ targetDir: 'C:\\Users\\foo' }), {
      agents: [],
      skills: [],
    })
    const issue = r.issues.find((i) => i.code === 'upload-input-target-dir-invalid')
    expect(issue).toBeDefined()
  })

  test('non-upload inputs are untouched', () => {
    const r = validateWorkflowDef(
      {
        $schema_version: 2,
        inputs: [{ kind: 'text', key: 'topic', label: 'topic' }],
        nodes: [
          {
            id: 'in_topic',
            kind: 'input',
            inputKey: 'topic',
          } as WorkflowDefinition['nodes'][number],
        ],
        edges: [],
      },
      { agents: [], skills: [] },
    )
    const codes = r.issues.map((i) => i.code)
    expect(codes).not.toContain('upload-input-target-dir-missing')
    expect(codes).not.toContain('upload-input-target-dir-invalid')
  })
})
