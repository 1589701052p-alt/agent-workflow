// RFC-W003 - event-driven trace polling for timing-sensitive tests.
//
// Replaces raw `expect(a.t < b.t)` + fixed-sleep timing assumptions. The
// assertion runs only after BOTH trace events are observed (polled to
// appearance), so the wall-clock ordering reflects real causality instead of
// racing a sleep budget that a slow/loaded runner can eat. The trace format
// is the newline-delimited JSON `<stateDir>/trace.jsonl` used by the rfc098
// commit-push shim and the scheduler-audit trace harnesses:
//   { agent: string, callIndex: number, phase: 'start'|'end', t: number }

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TraceEvent {
  agent: string
  callIndex: number
  phase: 'start' | 'end'
  t: number
}

/** Read (fresh, uncached) the trace.jsonl under `stateDir`. Empty if absent. */
export function readTrace(stateDir: string): TraceEvent[] {
  const path = join(stateDir, 'trace.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as TraceEvent)
}

/**
 * Poll `trace.jsonl` until an event matching `(agent, phase, callIndex?)`
 * appears, then return it. Throws on timeout (default 10s) - the timeout is a
 * DEADLINE (guards against a dead shim that never writes the event), NOT a
 * timing budget the assertion depends on. Use this to make a timing-order
 * assertion wait for its preconditions instead of assuming wall-clock.
 */
export async function waitForTraceEvent(
  stateDir: string,
  agent: string,
  phase: 'start' | 'end',
  opts: { callIndex?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<TraceEvent> {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const pollMs = opts.pollMs ?? 20
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = readTrace(stateDir).find(
      (e) =>
        e.agent === agent &&
        e.phase === phase &&
        (opts.callIndex === undefined || e.callIndex === opts.callIndex),
    )
    if (found) return found
    if (Date.now() >= deadline) {
      throw new Error(
        `waitForTraceEvent timed out after ${timeoutMs}ms waiting for ` +
          `{agent:${agent}, phase:${phase}` +
          (opts.callIndex === undefined ? '' : `, callIndex:${opts.callIndex}`) +
          `} in ${join(stateDir, 'trace.jsonl')}`,
      )
    }
    await Bun.sleep(pollMs)
  }
}
