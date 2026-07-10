// RFC-W001: raise bun:test's default per-test timeout for the whole backend
// suite, loaded via `bunfig.toml [test] preload` so it applies to every test
// file before any test runs.
//
// Why: bun:test's default per-test timeout is 5000ms. That is too tight for
// the process-heavy integration tests on the Windows CI runner (real git
// worktrees + mock-opencode subprocess spawns are materially slower there
// than on ubuntu/macos). When a test exceeds 5000ms, bun fires the timeout
// mid-run and immediately starts the NEXT test's beforeEach - clobbering the
// still-running test's shared `let`/`process.env` (the "S-RFC074 mirage"
// documented in clarify-review-combination-scenarios.test.ts). The clobber
// then makes OTHER, unrelated tests fail, so each CI run surfaced a different
// slice of "timeouts" depending on which test tripped the cliff first -
// whack-a-mole that per-file/per-test bumps couldn't keep up with.
//
// Raising the default file-wide (60s, matching the existing S-RFC074
// precedent) lets every integration test run to completion on Windows CI, so
// no test trips the 5s cliff and no cascade clobbers its neighbours. Fast
// unit tests are unaffected (they still finish in ms); only tests that
// genuinely exceed 5s see the new ceiling. A truly hung test still fails -
// just at 60s instead of 5s - which is an acceptable trade for stopping the
// cascade-driven false failures. Individual tests that need even longer keep
// their explicit `}, 60_000)` (or higher) overrides.
import { setDefaultTimeout } from 'bun:test'

setDefaultTimeout(60_000)
