// RFC-036 task collaborator schemas — rewritten for RFC-099 (D6/D10):
// the NodeAssignment* schemas are gone with the assignment mechanism, the
// role enum collapsed to owner|collaborator, and the members panel schemas
// (TaskMembers / UpdateTaskMembersBody) joined.

import { describe, expect, test } from 'bun:test'
import {
  TaskCollaboratorRoleSchema,
  TaskMembersSchema,
  UpdateTaskMembersBodySchema,
} from '../src/schemas/taskCollab'

describe('TaskCollaboratorRoleSchema', () => {
  test('accepts exactly the 2 RFC-099 roles', () => {
    for (const r of ['owner', 'collaborator']) {
      TaskCollaboratorRoleSchema.parse(r)
    }
  })
  test('rejects the retired RFC-036 role tags and other strings', () => {
    expect(() => TaskCollaboratorRoleSchema.parse('reviewer')).toThrow()
    expect(() => TaskCollaboratorRoleSchema.parse('clarify_target')).toThrow()
    expect(() => TaskCollaboratorRoleSchema.parse('observer')).toThrow()
    expect(() => TaskCollaboratorRoleSchema.parse('admin')).toThrow()
  })
})

describe('UpdateTaskMembersBodySchema', () => {
  test('accepts ownerUserId-only, userIds-only, and both', () => {
    UpdateTaskMembersBodySchema.parse({ ownerUserId: '01HQ' })
    UpdateTaskMembersBodySchema.parse({ userIds: ['01HQ', '01HR'] })
    UpdateTaskMembersBodySchema.parse({ ownerUserId: '01HQ', userIds: [] })
  })
  test('rejects the empty object (at least one field required)', () => {
    expect(() => UpdateTaskMembersBodySchema.parse({})).toThrow()
  })
  test('rejects empty-string ids', () => {
    expect(() => UpdateTaskMembersBodySchema.parse({ ownerUserId: '' })).toThrow()
    expect(() => UpdateTaskMembersBodySchema.parse({ userIds: [''] })).toThrow()
  })
})

describe('TaskMembersSchema', () => {
  test('round-trips the members panel response', () => {
    TaskMembersSchema.parse({
      taskId: 't1',
      ownerUserId: '01HQ',
      owner: {
        id: '01HQ',
        username: 'alice',
        displayName: 'Alice',
        role: 'user',
        status: 'active',
      },
      users: [],
      canManage: true,
    })
    TaskMembersSchema.parse({
      taskId: 't1',
      ownerUserId: null,
      owner: null,
      users: [],
      canManage: false,
    })
  })
})
