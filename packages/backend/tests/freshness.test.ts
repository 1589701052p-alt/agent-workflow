// RFC-074 PR-B — isNodeRunFresh + parseConsumedJson pure-function locks (B1-B4).
//
// The freshness predicate is the heart of the provenance rewrite: it decides
// whether a done node_run's recorded upstream consumption is still current, in
// place of the cci-watermark comparison. Locked here exhaustively because the
// scheduler's completed-set gating (T-B5) and per-batch demote (T-B6) both
// depend on these exact semantics — including the defensive "upstream with no
// current done row is NOT a staleness signal" and the "null/garbage consumed =
// fresh" hard-cut rule (design §9.1 / D4).

import { describe, expect, test } from 'bun:test'
import { isNodeRunFresh, parseConsumedJson } from '../src/services/freshness'
import type { nodeRuns } from '../src/db/schema'

type Row = typeof nodeRuns.$inferSelect

function run(id: string, consumed: Record<string, string> | null): Row {
  return {
    id,
    consumedUpstreamRunsJson: consumed === null ? null : JSON.stringify(consumed),
  } as unknown as Row
}
function doneRow(id: string): Row {
  return { id, status: 'done' } as unknown as Row
}
function fresnel(entries: Record<string, string>): Map<string, Row> {
  return new Map(Object.entries(entries).map(([up, id]) => [up, doneRow(id)]))
}

describe('RFC-074 PR-B — isNodeRunFresh (B1-B4)', () => {
  // B1 — empty consumed (input node / no upstream / legacy NULL row) → fresh.
  test('B1: empty consumed map → fresh', () => {
    expect(isNodeRunFresh(run('r', {}), fresnel({ designer: '01A' }))).toBe(true)
    expect(isNodeRunFresh(run('r', null), fresnel({ designer: '01A' }))).toBe(true)
  })

  // B2 — every consumed upstream run is still the freshest done → fresh.
  test('B2: all consumed == freshestDone → fresh', () => {
    const r = run('r', { designer: '01A', spec: '01B' })
    expect(isNodeRunFresh(r, fresnel({ designer: '01A', spec: '01B' }))).toBe(true)
  })

  // B3 — one upstream produced a newer done row (id differs) → stale.
  test('B3: one upstream advanced (id mismatch) → stale', () => {
    const r = run('r', { designer: '01A', spec: '01B' })
    // designer still matches, but spec advanced from 01B → 01B2.
    expect(isNodeRunFresh(r, fresnel({ designer: '01A', spec: '01B2' }))).toBe(false)
  })

  // B4 — defensive: a consumed upstream that has NO current-scope done row
  // (absent from the map, e.g. a settled cross-loop boundary input) is NOT a
  // staleness signal.
  test('B4: consumed upstream absent from freshestDone map → not stale (fresh)', () => {
    const r = run('r', { gitwrapper: '01OLD', designer: '01A' })
    // gitwrapper not in the current-scope freshest map; designer matches.
    expect(isNodeRunFresh(r, fresnel({ designer: '01A' }))).toBe(true)
  })
})

describe('RFC-074 PR-B — parseConsumedJson robustness', () => {
  test('null / empty / undefined → {}', () => {
    expect(parseConsumedJson(null)).toEqual({})
    expect(parseConsumedJson(undefined)).toEqual({})
    expect(parseConsumedJson('')).toEqual({})
  })
  test('malformed JSON / non-object / array → {}', () => {
    expect(parseConsumedJson('{not json')).toEqual({})
    expect(parseConsumedJson('"a string"')).toEqual({})
    expect(parseConsumedJson('42')).toEqual({})
    expect(parseConsumedJson('["a","b"]')).toEqual({})
    expect(parseConsumedJson('null')).toEqual({})
  })
  test('valid object keeps only string values', () => {
    expect(parseConsumedJson('{"a":"01X","b":"01Y"}')).toEqual({ a: '01X', b: '01Y' })
    // Non-string values are dropped (never a valid run id).
    expect(parseConsumedJson('{"a":"01X","b":5,"c":null}')).toEqual({ a: '01X' })
  })
})
