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
  // RFC-099 (D12): the memory write surface moved from admin-only to
  // route-gate-open — the real gate is per-row canManageMemory (scope-
  // resource owner or admin; repo/global rows stay admin-only at the check).
  test('user passes the route gate for all 5 memory perms (RFC-099)', () => {
    expect(hasPermission('user', 'memory:read')).toBe(true)
    expect(hasPermission('user', 'memory:write_feedback')).toBe(true)
    expect(hasPermission('user', 'memory:approve')).toBe(true)
    expect(hasPermission('user', 'memory:archive')).toBe(true)
    expect(hasPermission('user', 'memory:delete')).toBe(true)
  })
  test('no memory perm sits in ADMIN_ONLY_PERMISSIONS anymore (RFC-099)', () => {
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:approve')).toBe(false)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:archive')).toBe(false)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:delete')).toBe(false)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:read')).toBe(false)
    expect(ADMIN_ONLY_PERMISSIONS.includes('memory:write_feedback')).toBe(false)
  })
})
