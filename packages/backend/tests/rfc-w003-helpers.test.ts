// RFC-W003 - unit tests for the slow-runner + trace-poll helpers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTrace, waitForTraceEvent } from './helpers/trace-poll'
import { testDelay, testDelayMultiplier, testTolerance } from './helpers/slow-runner'

describe('RFC-W003 slow-runner - testDelay / testTolerance', () => {
  // MULT is captured ONCE at module load from AW_TEST_DELAY_MULTIPLIER (default 1).
  // We must NOT mutate process.env here: MULT is already snapshotted (so mutating
  // the env would be dead code), AND doing so would race with parallel test files
  // that call testDelay (process.env is process-global; bun:test runs files in
  // parallel). Instead assert the linear-scaling contract against the captured
  // multiplier, which holds under any env value set at suite launch.

  test('testDelay / testTolerance scale ms by the module-load multiplier', () => {
    // Dev box (no AW_TEST_DELAY_MULTIPLIER): MULT=1 -> byte-for-byte identity.
    // CI Windows gate (AW_TEST_DELAY_MULTIPLIER=2): MULT=2 -> 2x scaling.
    // The absolute factor is env-driven, so assert against testDelayMultiplier
    // rather than a hard-coded 1 - this passes under either configuration.
    expect(testDelay(100)).toBe(100 * testDelayMultiplier)
    expect(testTolerance(50)).toBe(50 * testDelayMultiplier)
    // When the multiplier is 1 (dev default), lock the identity explicitly:
    if (testDelayMultiplier === 1) {
      expect(testDelay(100)).toBe(100)
      expect(testTolerance(50)).toBe(50)
    }
  })

  test('multiplier is a positive finite number (>=1)', () => {
    expect(testDelayMultiplier).toBeGreaterThanOrEqual(1)
    expect(Number.isFinite(testDelayMultiplier)).toBe(true)
  })

  test('tolerance tracks delay 1:1 (sleep and margin widen in lockstep)', () => {
    // The core invariant: testDelay(x) and testTolerance(x) scale identically,
    // so widening a sleep never desyncs the allowed margin.
    for (const ms of [1, 100, 600, 1500]) {
      expect(testTolerance(ms)).toBe(testDelay(ms))
    }
  })
})

describe('RFC-W003 trace-poll - readTrace / waitForTraceEvent', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aw-w003-trace-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('readTrace: missing file -> []', () => {
    expect(readTrace(dir)).toEqual([])
  })

  test('readTrace: parses newline-delimited TraceEvent jsonl', () => {
    const line1 = JSON.stringify({ agent: 'n1', callIndex: 0, phase: 'start', t: 100 })
    const line2 = JSON.stringify({ agent: 'commit', callIndex: 0, phase: 'end', t: 700 })
    writeFileSync(join(dir, 'trace.jsonl'), line1 + '\n' + line2 + '\n')
    const ev = readTrace(dir)
    expect(ev).toHaveLength(2)
    expect(ev[0]!.agent).toBe('n1')
    expect(ev[1]!.phase).toBe('end')
  })

  test('waitForTraceEvent: returns immediately when event already present', async () => {
    writeFileSync(
      join(dir, 'trace.jsonl'),
      JSON.stringify({ agent: 'n1', callIndex: 0, phase: 'start', t: 5 }) + '\n',
    )
    const ev = await waitForTraceEvent(dir, 'n1', 'start', { timeoutMs: 500 })
    expect(ev.t).toBe(5)
  })

  test('waitForTraceEvent: polls until event appears mid-wait', async () => {
    // write the event after a short delay; waitForTraceEvent must poll and find it
    setTimeout(
      () =>
        writeFileSync(
          join(dir, 'trace.jsonl'),
          JSON.stringify({ agent: 'n2', callIndex: 0, phase: 'end', t: 42 }) + '\n',
        ),
      60,
    )
    const ev = await waitForTraceEvent(dir, 'n2', 'end', { timeoutMs: 2000, pollMs: 20 })
    expect(ev.t).toBe(42)
  })

  test('waitForTraceEvent: respects callIndex filter', async () => {
    writeFileSync(
      join(dir, 'trace.jsonl'),
      JSON.stringify({ agent: 'commit', callIndex: 0, phase: 'end', t: 1 }) +
        '\n' +
        JSON.stringify({ agent: 'commit', callIndex: 1, phase: 'end', t: 2 }) +
        '\n',
    )
    const ev = await waitForTraceEvent(dir, 'commit', 'end', { callIndex: 1, timeoutMs: 500 })
    expect(ev.callIndex).toBe(1)
    expect(ev.t).toBe(2)
  })

  test('waitForTraceEvent: throws on timeout (event never appears)', async () => {
    await expect(
      waitForTraceEvent(dir, 'never', 'start', { timeoutMs: 200, pollMs: 20 }),
    ).rejects.toThrow(/timed out after 200ms/)
  })
})
