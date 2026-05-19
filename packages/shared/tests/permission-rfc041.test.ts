// RFC-041 — locks the 5 new permissions and the admin / user split.

import { describe, expect, test } from 'bun:test'
import {
  ADMIN_ONLY_PERMISSIONS,
  hasPermission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
} from '../src/schemas/permission'

const RFC041_PERMS = [
  'memory:read',
  'memory:approve',
  'memory:archive',
  'memory:delete',
  'memory:write_feedback',
] as const

describe('PERMISSIONS literal — RFC-041 additions', () => {
  test('all 5 memory perms exist', () => {
    for (const p of RFC041_PERMS) {
      expect(PERMISSIONS.includes(p)).toBe(true)
    }
  })
})

describe('ROLE_PERMISSIONS — RFC-041', () => {
  test('admin has all 5 memory perms', () => {
    for (const p of RFC041_PERMS) {
      expect(hasPermission('admin', p)).toBe(true)
    }
  })
  test('user has only memory:read + memory:write_feedback', () => {
    expect(hasPermission('user', 'memory:read')).toBe(true)
    expect(hasPermission('user', 'memory:write_feedback')).toBe(true)
    expect(hasPermission('user', 'memory:approve')).toBe(false)
    expect(hasPermission('user', 'memory:archive')).toBe(false)
    expect(hasPermission('user', 'memory:delete')).toBe(false)
  })
  test('ADMIN_ONLY_PERMISSIONS includes the 3 write perms but not read/feedback', () => {
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:approve')).toBe(true)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:archive')).toBe(true)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:delete')).toBe(true)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:read')).toBe(false)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:write_feedback')).toBe(false)
  })
})
