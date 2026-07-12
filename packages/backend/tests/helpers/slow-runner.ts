// RFC-W003 - slow-runner test delay/tolerance scaling.
//
// CI runners (especially windows-latest under load) run subprocesses 3-5x
// slower than a local dev box. Hardcoded sleep budgets (CP_COMMIT_DELAYS,
// MOCK_OPENCODE_DELAY_MS, WRITER_DELAY_MS, S17_DELAY_MS_FOR_*) and the
// structural margins tests assume around them get eaten, causing wall-clock
// timing flakes (the RFC-098 commit-push flake: ~600ms margin swallowed by
// dispatch overhead).
//
// Set `AW_TEST_DELAY_MULTIPLIER=2` (or 3) on slow runners to scale every
// delay AND its matching tolerance together, so a test's timing assumptions
// stay internally consistent (sleep widens, the allowed margin widens with
// it). Default 1 = POSIX / fast machine, byte-for-byte behavior unchanged.

const MULT_RAW = Number(process.env.AW_TEST_DELAY_MULTIPLIER ?? '1')
const MULT = Number.isFinite(MULT_RAW) && MULT_RAW > 0 ? MULT_RAW : 1

/** The active multiplier (default 1). Exposed for diagnostics / branching. */
export const testDelayMultiplier = MULT

/**
 * Scale a test-internal sleep/delay (ms) by the slow-runner multiplier.
 * Use for every value fed to a `CP_*_DELAYS` / `*_DELAY_MS` env var or
 * `setTimeout`/`Bun.sleep` in a timing-sensitive test.
 */
export function testDelay(ms: number): number {
  return ms * MULT
}

/**
 * Scale a timing-assertion tolerance (ms) by the SAME multiplier. Sleeps and
 * the tolerances around them must widen in lockstep - if you only widen the
 * sleep the assertion's allowed margin desyncs and the flake stays.
 */
export function testTolerance(ms: number): number {
  return ms * MULT
}
