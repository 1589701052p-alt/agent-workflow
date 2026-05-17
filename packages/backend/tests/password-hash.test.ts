// RFC-036 — argon2id hash/verify via Bun.password wrapper.

import { describe, expect, test } from 'bun:test'
import { hashPassword, verifyPassword } from '../src/auth/passwords'

describe('hashPassword / verifyPassword', () => {
  test('round-trip succeeds for the same plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(hash).toMatch(/^\$argon2id\$/)
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true)
  })

  test('verify rejects the wrong plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple')
    expect(await verifyPassword('wrong-pw', hash)).toBe(false)
  })

  test('verify gracefully rejects malformed hash', async () => {
    expect(await verifyPassword('any', '')).toBe(false)
    expect(await verifyPassword('any', 'not-a-hash')).toBe(false)
  })

  test('rejects short input at hash time', async () => {
    await expect(hashPassword('short')).rejects.toThrow(/too short/)
  })
})
