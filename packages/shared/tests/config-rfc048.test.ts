// RFC-048 — ConfigSchema additions for the subagent live-capture poller.
//
// Locks the new `subagentLiveCapture` field (optional) + its integer ranges
// (`pollMs ∈ [0, 60_000]`, `consecutiveFailureLimit ∈ [1, 100]`) and the
// DEFAULT_SUBAGENT_LIVE_CAPTURE constant against the ConfigSchema /
// ConfigPatchSchema contract. Keeps the existing DEFAULT_CONFIG path
// backward-compatible (omitted = degrades to RFC-027 only when the runner
// explicitly checks for the absence).

import { describe, expect, test } from 'bun:test'

import {
  ConfigPatchSchema,
  ConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_SUBAGENT_LIVE_CAPTURE,
} from '../src/schemas/config.js'

describe('RFC-048 ConfigSchema additions', () => {
  test('accepts a valid subagentLiveCapture object', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      subagentLiveCapture: { pollMs: 2000, consecutiveFailureLimit: 3 },
    })
    expect(parsed.subagentLiveCapture).toEqual({
      pollMs: 2000,
      consecutiveFailureLimit: 3,
    })
  })

  test('omitted field stays undefined (backward-compatible default)', () => {
    const parsed = ConfigSchema.parse({ ...DEFAULT_CONFIG })
    expect(parsed.subagentLiveCapture).toBeUndefined()
  })

  test('pollMs = 0 is allowed (disables live polling)', () => {
    const parsed = ConfigSchema.parse({
      ...DEFAULT_CONFIG,
      subagentLiveCapture: { pollMs: 0, consecutiveFailureLimit: 5 },
    })
    expect(parsed.subagentLiveCapture?.pollMs).toBe(0)
  })

  test('pollMs upper bound 60_000 accepted; 60_001 rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 60_000, consecutiveFailureLimit: 5 },
      }),
    ).not.toThrow()
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 60_001, consecutiveFailureLimit: 5 },
      }),
    ).toThrow()
  })

  test('negative pollMs rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: -1, consecutiveFailureLimit: 5 },
      }),
    ).toThrow()
  })

  test('consecutiveFailureLimit bounds 1 and 100 both accepted', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 1500, consecutiveFailureLimit: 1 },
      }),
    ).not.toThrow()
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 1500, consecutiveFailureLimit: 100 },
      }),
    ).not.toThrow()
  })

  test('consecutiveFailureLimit 0 and 101 rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 1500, consecutiveFailureLimit: 0 },
      }),
    ).toThrow()
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 1500, consecutiveFailureLimit: 101 },
      }),
    ).toThrow()
  })

  test('non-integer pollMs rejected', () => {
    expect(() =>
      ConfigSchema.parse({
        ...DEFAULT_CONFIG,
        subagentLiveCapture: { pollMs: 100.5, consecutiveFailureLimit: 5 },
      }),
    ).toThrow()
  })

  test('ConfigPatchSchema accepts subagentLiveCapture as a partial', () => {
    const parsed = ConfigPatchSchema.parse({
      subagentLiveCapture: { pollMs: 750, consecutiveFailureLimit: 10 },
    })
    expect(parsed.subagentLiveCapture?.pollMs).toBe(750)
  })

  test('DEFAULT_SUBAGENT_LIVE_CAPTURE is the single source of truth (1500 / 5)', () => {
    expect(DEFAULT_SUBAGENT_LIVE_CAPTURE).toEqual({
      pollMs: 1500,
      consecutiveFailureLimit: 5,
    })
  })
})
