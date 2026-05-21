// RFC-054 W1-2 — grep guard: shared API schemas must NOT contain `z.any()`.
//
// LOCKS: every shared Zod schema must declare a concrete shape so the
// contract suite (and downstream type-safe fetch wrappers) can validate
// responses. `z.any()` and `z.unknown()` are escape hatches that erase the
// contract; they're allowed in test code (registry happy fixtures often use
// `z.any()` inside list-element schemas) but never in production shared
// schemas.
//
// If a future Zod schema legitimately needs an open value (e.g. arbitrary
// JSON body), use `z.record(z.unknown())` plus a `.passthrough()` on the
// surrounding object — that documents intent without erasing the wrapper.

import { describe, test, expect } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SHARED_SCHEMAS_DIR = resolve(import.meta.dir, '..', '..', 'shared', 'src', 'schemas')

const BANNED_PATTERNS = [
  // `z.any(`  — note the open paren disambiguates from comment text "z.any"
  /\bz\.any\s*\(/,
] as const

// Allowlist: file paths (relative to SHARED_SCHEMAS_DIR) where a banned
// pattern is intentionally present. Each entry must include a `Reason:` line
// in the file pointing future readers to why. As of W1-2 the allowlist is
// empty.
const ALLOWLIST = new Set<string>()

function listSharedSchemas(): string[] {
  return readdirSync(SHARED_SCHEMAS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(SHARED_SCHEMAS_DIR, f))
}

describe('shared API schemas — no `z.any()` escape hatch', () => {
  test('no shared/src/schemas/*.ts file contains z.any()', () => {
    const files = listSharedSchemas()
    expect(files.length).toBeGreaterThan(0) // sanity

    const offenders: { file: string; line: number; text: string }[] = []
    for (const f of files) {
      const rel = f.slice(SHARED_SCHEMAS_DIR.length + 1)
      if (ALLOWLIST.has(rel)) continue
      const src = readFileSync(f, 'utf-8')
      const lines = src.split('\n')
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!
        // Skip lines that are entirely a comment.
        if (/^\s*(\/\/|\*)/.test(line)) continue
        for (const re of BANNED_PATTERNS) {
          if (re.test(line)) {
            offenders.push({ file: rel, line: i + 1, text: line.trim() })
          }
        }
      }
    }

    if (offenders.length > 0) {
      const msg = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n')
      throw new Error(
        `RFC-054 W1-2 — banned z.any() in shared schemas:\n${msg}\n\n` +
          `Use z.record(z.unknown()) + .passthrough() on the wrapper instead. If absolutely\n` +
          `required, add the file to ALLOWLIST in this test with a Reason comment.`,
      )
    }
  })
})
