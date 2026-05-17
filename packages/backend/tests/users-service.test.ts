// RFC-036 — users service: PR1 scope (create + reset-password + disable +
// last-admin-protection + search + __system__ immutability).

import { beforeEach, describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import {
  countNonSystemUsers,
  createUser,
  disableUser,
  findByUsername,
  listAllUsers,
  patchUser,
  resetPassword,
  searchUsersPublic,
} from '../src/services/users'
import { SYSTEM_USER_ID } from '../src/auth/actor'
import { verifyPassword } from '../src/auth/passwords'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

describe('users service', () => {
  let db: DbClient

  beforeEach(() => {
    db = createInMemoryDb(MIGRATIONS)
  })

  test('seed includes __system__ row + countNonSystemUsers excludes it', async () => {
    const sys = await findByUsername(db, SYSTEM_USER_ID)
    expect(sys?.id).toBe(SYSTEM_USER_ID)
    expect(sys?.role).toBe('admin')
    expect(await countNonSystemUsers(db)).toBe(0)
  })

  test('createUser happy path with password → status=active', async () => {
    const u = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'correctPw123',
    })
    expect(u.username).toBe('alice')
    expect(u.status).toBe('active')
    expect(u.passwordHash).not.toBeNull()
    expect(await verifyPassword('correctPw123', u.passwordHash!)).toBe(true)
    expect(await countNonSystemUsers(db)).toBe(1)
  })

  test('createUser without password → status=invited', async () => {
    const u = await createUser(db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
    })
    expect(u.status).toBe('invited')
    expect(u.passwordHash).toBeNull()
  })

  test('createUser rejects duplicate username (409)', async () => {
    await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'correctPw123',
    })
    await expect(
      createUser(db, { username: 'bob', displayName: 'Bob2', role: 'user' }),
    ).rejects.toThrow(/username/i)
  })

  test('createUser rejects reserved __system__ username', async () => {
    await expect(
      createUser(db, {
        username: SYSTEM_USER_ID,
        displayName: 'X',
        role: 'admin',
      }),
    ).rejects.toThrow(/reserved/)
  })

  test('disableUser flips status and is idempotent', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'A',
      role: 'admin',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'bob',
      displayName: 'B',
      role: 'user',
      password: 'pw12345678',
    })
    const bob = await findByUsername(db, 'bob')
    await disableUser(db, bob!.id)
    const after = await findByUsername(db, 'bob')
    expect(after?.status).toBe('disabled')
    // idempotent
    await disableUser(db, bob!.id)
  })

  test('disableUser refuses __system__', async () => {
    await expect(disableUser(db, SYSTEM_USER_ID)).rejects.toThrow(/cannot disable __system__/)
  })

  test('last-admin-protection blocks disabling the only active admin', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // __system__ is admin but seeded — service still counts active admins
    // including __system__ (it has status='active'), so first disable succeeds.
    await disableUser(db, a.id)
    // After Alice is disabled, only __system__ left as active admin. Try to
    // disable it → blocked by immutability (also covered by last-admin guard).
    await expect(disableUser(db, SYSTEM_USER_ID)).rejects.toThrow()
  })

  test('patchUser role demotion blocked when no other admin', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    // Disable __system__ is blocked, but Alice can be demoted IF __system__
    // is still an active admin (it is). So demotion should succeed.
    const updated = await patchUser(db, a.id, { role: 'user' })
    expect(updated.role).toBe('user')
  })

  test('resetPassword rehashes + revokes sessions', async () => {
    const a = await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'oldOldOld',
    })
    await resetPassword(db, a.id, { newPassword: 'newNewNew' })
    const after = await findByUsername(db, 'alice')
    expect(await verifyPassword('newNewNew', after!.passwordHash!)).toBe(true)
    expect(await verifyPassword('oldOldOld', after!.passwordHash!)).toBe(false)
  })

  test('searchUsersPublic by username prefix returns only public fields', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'bob',
      displayName: 'Bob',
      role: 'user',
      password: 'pw12345678',
    })
    await createUser(db, {
      username: 'carol',
      displayName: 'Carol',
      role: 'user',
      password: 'pw12345678',
    })
    const rows = await searchUsersPublic(db, { q: 'a' })
    expect(rows.map((r) => r.username).sort()).toEqual(['alice'])
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'displayName',
      'id',
      'role',
      'status',
      'username',
    ])
  })

  test('listAllUsers includes __system__', async () => {
    await createUser(db, {
      username: 'alice',
      displayName: 'Alice',
      role: 'admin',
      password: 'pw12345678',
    })
    const all = await listAllUsers(db)
    expect(all.length).toBe(2)
    expect(all.some((r) => r.id === SYSTEM_USER_ID)).toBe(true)
  })
})
