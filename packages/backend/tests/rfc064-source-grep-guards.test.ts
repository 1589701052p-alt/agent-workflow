// RFC-064 PR-B T17 — source-code grep guards.
//
// Locks the post-unification source-level invariants:
//   C3: `crossClarifyIteration` / `cross_clarify_iteration` absent from
//       packages/backend/src/, packages/shared/src/, packages/frontend/src/
//       (the migration 0035 SQL file is the only allowed occurrence — it
//       references the dropped column name in its DROP statement).
//   C4: services/clarify.ts re-exports the cross-clarify helpers that used
//       to live in services/crossClarify.ts (file kept for now, but the
//       `buildExternalFeedbackContext` symbol is part of the unified
//       interface).
//   C6: `isFresherForCutoff` (services/clarifyRounds.ts) ranks on the
//       3-layer key (clarifyIteration → retryIndex → id).
//   C9-747dcae: scheduler.ts has both branches of the
//       `applyLatestDirective` gate using the shared `isClarifyRerun`
//       variable. The OR-pattern source-text guard in
//       cross-clarify-stop-directive-scoped-to-cci-rerun.test.ts already
//       enforces the cross-questioner branch; this file adds a count check
//       so both branches stay in sync.

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'

const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..')

function gitGrep(pattern: string, paths: string[]): string[] {
  try {
    const out = execSync(
      `git grep --line-number ${JSON.stringify(pattern)} -- ${paths.map((p) => JSON.stringify(p)).join(' ')}`,
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
    return out.split('\n').filter((l) => l.length > 0)
  } catch {
    // git grep exits non-zero when there are no matches; that's the green case.
    return []
  }
}

describe('RFC-064 C3 — cross-clarify counter absent from live source code', () => {
  // We grep for property / field ACCESSES rather than the bare identifier so
  // historical commentary that names the dropped column (e.g. "this used to
  // mirror crossClarifyIteration") doesn't trip the guard. The patterns
  // below catch every way a live code path could still touch the field:
  //   - `.crossClarifyIteration`           (object property access)
  //   - `crossClarifyIteration:`           (object literal key)
  //   - `nodeRuns.crossClarifyIteration`   (drizzle column reference)
  // The same approach for the snake_case SQL column name.
  const SRC_PATHS = ['packages/backend/src', 'packages/shared/src', 'packages/frontend/src']

  function findCodeReferences(identifier: string, pathList: string[]): string[] {
    const accessPattern = `\\.${identifier}\\b`
    const keyPattern = `\\b${identifier}\\s*:`
    const accessHits = gitGrep(`-E`, [...pathList]) // unused — kept for shape
    void accessHits
    const a = gitGrep(accessPattern, pathList).filter((l) => !/^\s*\*|^\s*\/\//.test(l))
    const b = gitGrep(keyPattern, pathList).filter((l) => !/^\s*\*|^\s*\/\//.test(l))
    return [...a, ...b]
  }

  test('crossClarifyIteration property access / field-literal absent from source code', () => {
    const hits = findCodeReferences('crossClarifyIteration', SRC_PATHS)
    if (hits.length > 0) {
      throw new Error(`Unexpected crossClarifyIteration code references:\n${hits.join('\n')}`)
    }
    expect(hits.length).toBe(0)
  })

  test('cross_clarify_iteration column-name absent from source code (SQL files exempt)', () => {
    // Migration 0035 references the dropped column in its DROP statement —
    // that's in db/migrations/, outside the src/ trees.
    const hits = findCodeReferences('cross_clarify_iteration', SRC_PATHS)
    if (hits.length > 0) {
      throw new Error(`Unexpected cross_clarify_iteration code references:\n${hits.join('\n')}`)
    }
    expect(hits.length).toBe(0)
  })
})

// RFC-064 C6 — `isFresherForCutoff` is gone under RFC-070 along with the rest
// of the iteration-cutoff code path (see RFC-070 §3 / migration 0036). The
// freshness-comparator role is no longer needed because aging is now per-row
// state (`consumed_by_..._run_id IS NULL`), not a numeric cutoff. The grep
// guard that locked the 3-layer sort key would now fail vacuously; the
// `rfc070-aging-stamp-grep-guards.test.ts` C-group locks the new contract.

describe('RFC-064 C9 — applyLatestDirective gate merged into shared isClarifyRerun', () => {
  test('scheduler.ts has at least 2 applyLatestDirective occurrences (self + cross-questioner branches)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    const matches = src.match(/applyLatestDirective/g) ?? []
    // Each branch's buildPromptContext call passes applyLatestDirective; the
    // gate's `const isClarifyRerun = ...` definition (~scheduler.ts:1381)
    // does not itself contain the literal `applyLatestDirective`. So the
    // minimum is exactly the two branch usages.
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })

  test('scheduler.ts uses applyLatestDirective: isClarifyRerun in at least 2 places (747dcae merger)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/services/scheduler.ts'),
      'utf8',
    )
    const matches = src.match(/applyLatestDirective:\s*isClarifyRerun/g) ?? []
    // PR-B merged the two branches' gate expressions to the shared
    // variable. Both branches MUST use it; if a future refactor reverts
    // one branch back to a literal `(currentRunRow?.retryIndex ?? 0) === 0`,
    // this guard catches the silent split.
    expect(matches.length).toBeGreaterThanOrEqual(2)
  })
})

describe('RFC-064 C4 — services exports', () => {
  test('services/clarify.ts is the canonical home for clarify lifecycle helpers', () => {
    const src = readFileSync(resolve(REPO_ROOT, 'packages/backend/src/services/clarify.ts'), 'utf8')
    // These exports are the public surface other modules call. PR-B kept
    // crossClarify.ts as a deferred-merge file (the helper functions live
    // there); when a follow-up moves them into clarify.ts, this list grows.
    expect(src).toContain('export async function submitClarifyAnswers')
    expect(src).toContain('export async function createClarifySession')
  })

  test('services/crossClarify.ts exports buildExternalFeedbackContext (signature unchanged in design)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/backend/src/services/crossClarify.ts'),
      'utf8',
    )
    expect(src).toContain('export async function buildExternalFeedbackContext(')
  })
})
