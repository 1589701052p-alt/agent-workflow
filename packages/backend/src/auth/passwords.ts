// RFC-036 — argon2id password hashing. We use Bun.password (argon2id by
// default) instead of adding a native dep; this keeps the single-binary build
// (M5) simple and Bun-only — every supported runtime ships Bun.
//
// Parameters track OWASP 2024 guidance for argon2id (memory ≈ 19 MiB,
// timeCost = 2, parallelism = 1).

const HASH_OPTS = {
  algorithm: 'argon2id' as const,
  memoryCost: 19_456,
  timeCost: 2,
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < 8) {
    throw new Error('password too short')
  }
  return Bun.password.hash(plaintext, HASH_OPTS)
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  if (!hash) return false
  try {
    return await Bun.password.verify(plaintext, hash)
  } catch {
    return false
  }
}

// RFC-103 T9 (10-ACL): a fixed dummy argon2id hash (same params as real ones).
// Computed EAGERLY at module load (off the request path) and reused, so the
// FIRST rejected login doesn't pay an extra argon2 HASH that the wrong-password
// path doesn't — that cold path would otherwise still be timing-distinguishable
// (Codex impl-gate P3). Login's "no user / inactive / no passwordHash" branches
// verify against it so an attacker can't distinguish those from a wrong password.
const dummyHashPromise: Promise<string> = Bun.password.hash(
  'aw-constant-time-dummy-secret',
  HASH_OPTS,
)
// Don't surface an unhandled rejection if the warm-up somehow fails; the verify
// below re-awaits and is wrapped in try/catch.
dummyHashPromise.catch(() => {})

/**
 * RFC-103 T9: run a real argon2id verify against a constant (pre-warmed) dummy
 * hash and always resolve `false`. Call this on login paths that reject BEFORE
 * checking a real hash (unknown user / inactive / no passwordHash) so total
 * response time matches the wrong-password path and does not leak account
 * existence/state — including on the very first probe after daemon start.
 */
export async function verifyPasswordDummy(plaintext: string): Promise<false> {
  try {
    await Bun.password.verify(plaintext, await dummyHashPromise)
  } catch {
    // ignore — timing is the point, not the result
  }
  return false
}
