// RFC-W003 C1 source lock - no POSIX-only `/usr/bin/env` opencodeCmd in tests.
//
// `/usr/bin/env` does not exist on Windows (ENOENT). Tests that used it as a
// placeholder opencodeCmd either ENOENT silently (spawn path not reached) or,
// worse, trigger internal retries that burn the per-test timeout on a slow
// Windows runner (the RFC-053 lifecycle-property flake). The fix migrates
// every site to the cross-platform `noopOpencodeCmd()` (deps-shape-only) or
// `stubCmd(writeStubOpencode(...))` (spawn asserted).
//
// This lock greps backend tests/ for any surviving `'/usr/bin/env'` opencodeCmd
// usage so a future refactor can't silently reintroduce the POSIX-only path.
// The T4 sweep migrated all 26 sites (11 files, T1 baseline) to noopOpencodeCmd()
// / stubCmd(writeStubOpencode(...)); this assertion locks the count at 0. If a new
// test turns it red, switch that opencodeCmd to noopOpencodeCmd() / stubCmd(...).

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const TESTS_DIR = join(__dirname, '..', 'tests')

function listTestFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      out.push(...listTestFiles(full))
    } else if (name.endsWith('.test.ts')) {
      // Skip this lock file itself - its comments + regex mention '/usr/bin/env'
      // as documentation, which is not a real opencodeCmd usage.
      if (name === 'rfc-w003-no-posix-env-cmd.test.ts') continue
      out.push(full)
    }
  }
  return out
}

/** Count `'/usr/bin/env'` opencodeCmd usages across backend test files.
 *  Excludes .sh shebangs (these are .ts files; no shebangs expected). */
function countPosixEnvOpencodeCmd(): {
  total: number
  byFile: Array<{ file: string; count: number }>
} {
  const byFile: Array<{ file: string; count: number }> = []
  let total = 0
  for (const f of listTestFiles(TESTS_DIR)) {
    const src = readFileSync(f, 'utf8')
    // Match the literal string '/usr/bin/env' used as an opencodeCmd element.
    // (Plain string search - matches both inline `opencodeCmd: ['/usr/bin/env', ...]`
    // and DEPS/DEPS_CMD constants that feed opencodeCmd.)
    const matches = src.match(/'\/usr\/bin\/env'/g)
    const count = matches?.length ?? 0
    if (count > 0) {
      byFile.push({ file: f.replace(/^[^\n]*[\\/](tests[\\/].*)$/, '$1'), count })
      total += count
    }
  }
  return { total, byFile }
}

describe('RFC-W003 C1 - no POSIX-only /usr/bin/env opencodeCmd in backend tests', () => {
  it('zero surviving /usr/bin/env opencodeCmd usages (T4 sweep complete)', () => {
    const { total, byFile } = countPosixEnvOpencodeCmd()
    // Locked at 0: T1 baseline was 26 across 11 files; the T4 sweep migrated
    // every site to noopOpencodeCmd() / stubCmd(writeStubOpencode(...)). Any
    // non-zero value is a regression - do not bump this; fix the offending site.
    expect(total).toBe(0)
    // If red, these files still use /usr/bin/env as opencodeCmd:
    if (total > 0) {
      console.error('surviving /usr/bin/env opencodeCmd:', byFile)
    }
  })
})
