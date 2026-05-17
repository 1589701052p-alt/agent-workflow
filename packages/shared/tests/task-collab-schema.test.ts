// RFC-036 — task collaborator + node assignment schemas.

import { describe, expect, test } from 'bun:test'
import {
  NodeAssignmentInputSchema,
  NodeAssignmentKindSchema,
  TaskCollaboratorRoleSchema,
} from '../src/schemas/taskCollab'

describe('TaskCollaboratorRoleSchema', () => {
  test('accepts exactly the 4 documented roles', () => {
    for (const r of ['owner', 'reviewer', 'clarify_target', 'collaborator']) {
      TaskCollaboratorRoleSchema.parse(r)
    }
  })
  test('rejects other strings', () => {
    expect(() => TaskCollaboratorRoleSchema.parse('observer')).toThrow()
    expect(() => TaskCollaboratorRoleSchema.parse('admin')).toThrow()
  })
})

describe('NodeAssignmentKindSchema', () => {
  test('accepts only reviewer | clarify_target', () => {
    NodeAssignmentKindSchema.parse('reviewer')
    NodeAssignmentKindSchema.parse('clarify_target')
    expect(() => NodeAssignmentKindSchema.parse('collaborator')).toThrow()
    expect(() => NodeAssignmentKindSchema.parse('owner')).toThrow()
  })
})

describe('NodeAssignmentInputSchema', () => {
  test('happy path', () => {
    NodeAssignmentInputSchema.parse({
      nodeId: 'final-doc',
      kind: 'reviewer',
      userId: '01HQ',
    })
  })
  test('rejects empty nodeId / userId', () => {
    expect(() =>
      NodeAssignmentInputSchema.parse({ nodeId: '', kind: 'reviewer', userId: '01' }),
    ).toThrow()
    expect(() =>
      NodeAssignmentInputSchema.parse({ nodeId: 'n', kind: 'reviewer', userId: '' }),
    ).toThrow()
  })
})
