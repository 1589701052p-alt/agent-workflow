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
