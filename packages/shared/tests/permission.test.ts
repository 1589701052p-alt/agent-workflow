// RFC-036 — permission catalog snapshot + role mapping invariants. These
// guard against the most common multi-user regression: silently adding a
// write permission to the `user` role (privilege escalation) or removing a
// read permission (UI breakage). Both directions are pinned.

import { describe, expect, test } from 'bun:test'
import {
  ADMIN_ONLY_PERMISSIONS,
  hasPermission,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  type Permission,
} from '../src/schemas/permission'

describe('PERMISSIONS catalog', () => {
  test('contains the documented 33 entries', () => {
    expect(PERMISSIONS.length).toBe(33)
  })

  test('admin role is the full PERMISSIONS set', () => {
    const adminSet = new Set<Permission>(ROLE_PERMISSIONS.admin)
    for (const p of PERMISSIONS) {
      expect(adminSet.has(p)).toBe(true)
    }
    expect(ROLE_PERMISSIONS.admin.length).toBe(PERMISSIONS.length)
  })

  test('user role contains exactly the documented baseline (23 entries)', () => {
    const expected: Permission[] = [
      'agents:read',
      'skills:read',
      'mcps:read',
      'plugins:read',
      'workflows:read',
      'repos:read',
      'runtime:read',
      // RFC-099 — resource writes are route-gate-open for all users; the
      // per-row owner/grant check lives in services/resourceAcl.ts.
      'agents:write',
      'skills:write',
      'mcps:write',
      'plugins:write',
      'workflows:write',
      'users:search',
      'tasks:launch',
      'tasks:read:own',
      'tasks:cancel:own',
      'account:self',
      // RFC-041 — read approved memories + write task feedback
      'memory:read',
      'memory:write_feedback',
      // RFC-099 (D12) — route gate open; per-row canManageMemory is the gate
      'memory:approve',
      'memory:archive',
      'memory:delete',
      'memory:edit',
    ]
    expect([...ROLE_PERMISSIONS.user].sort()).toEqual(expected.sort())
  })

  test('user role does NOT include any admin-only point (snapshot guard)', () => {
    const adminOnly: Permission[] = [
      // RFC-099: repos stay OUT of the ownership ACL model — repos:write
      // remains admin-only while the five resource writes moved to baseline.
      'repos:write',
      'users:read',
      'users:write',
      'settings:read',
      'settings:write',
      'oidc:read',
      'oidc:configure',
      'backup:run',
      'tasks:read:all',
      'tasks:cancel:all',
    ]
    for (const p of adminOnly) {
      expect(ROLE_PERMISSIONS.user.includes(p)).toBe(false)
    }
    expect([...ADMIN_ONLY_PERMISSIONS].sort()).toEqual(adminOnly.sort())
  })

  test('hasPermission truth matrix', () => {
    expect(hasPermission('admin', 'agents:write')).toBe(true)
    expect(hasPermission('admin', 'oidc:configure')).toBe(true)
    expect(hasPermission('admin', 'users:read')).toBe(true)
    expect(hasPermission('user', 'agents:read')).toBe(true)
    // RFC-099: route-gate write open to users (row-level ACL is the real gate)
    expect(hasPermission('user', 'agents:write')).toBe(true)
    expect(hasPermission('user', 'repos:write')).toBe(false)
    expect(hasPermission('user', 'settings:read')).toBe(false)
    expect(hasPermission('user', 'users:read')).toBe(false)
    expect(hasPermission('user', 'users:search')).toBe(true)
    expect(hasPermission('user', 'tasks:read:all')).toBe(false)
    expect(hasPermission('user', 'tasks:read:own')).toBe(true)
  })
})
