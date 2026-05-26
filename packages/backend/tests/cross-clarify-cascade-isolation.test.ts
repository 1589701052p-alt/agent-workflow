// RFC-056 C8 — cross-clarify cascade isolation.
//
// RFC-064 STATUS: this file's tests pinned the two-counter isolation
// invariant — that `clarifyIteration` and the now-removed
// `crossClarifyIteration` were independent columns and the cross-clarify
// rerun bumped only the cross counter. RFC-064 unified the two into a
// single `clarifyIteration` column, so the isolation invariant no longer
// exists by construction (a cross-clarify rerun bumps the unified
// counter, same as a self-clarify rerun). The behavioral coverage
// previously here is replaced by:
//   - cross-clarify-baseline-service.test.ts (mint helper bump algorithm)
//   - cross-clarify-baseline-patches.test.ts (10 dated patches' end-to-end
//     scenarios under the unified counter)
//   - clarify-iteration-bump-rules-rfc064.test.ts (RFC-064 baseline)
//
// Kept as a 1-test stub so future readers see the migration note rather
// than a missing-file error and so the source-text grep guards in
// other tests can still locate the file path.

import { describe, expect, test } from 'bun:test'

describe('RFC-064 — cross-clarify cascade isolation tests retired', () => {
  test('the two-counter isolation invariant no longer applies (counters unified)', () => {
    expect(true).toBe(true)
  })
})
