// RFC-W003 - unit tests for the slow-runner + trace-poll helpers.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTrace, waitForTraceEvent } from './helpers/trace-poll'
import { testDelay, testDelayMultiplier, testTolerance } from './helpers/slow-runner'

describe('RFC-W003 slow-runner - testDelay / testTolerance', () => {
  const prev = process.env.AW_TEST_DELAY_MULTIPLIER
  afterEach(() => {
    if (prev === undefined) delete process.env.AW_TEST_DELAY_MULTIPLIER
    else process.env.AW_TEST_DELAY_MULTIPLIER = prev
  })

  test('default multiplier 1 = identity (POSIX / fast machine byte-for-byte)', () => {
    delete process.env.AW_TEST_DELAY_MULTIPLIER
    // re-import would be cleaner, but MULT is read at module load; since the
    // env is unset here the default path is exercised by the const at import.
    // We assert the contract: testDelay/testTolerance are pure ms -> ms.
    expect(testDelay(100)).toBe(100)
    expect(testTolerance(50)).toBe(50)
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
