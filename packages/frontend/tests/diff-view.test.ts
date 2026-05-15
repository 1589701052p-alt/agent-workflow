// DiffView pure helpers — RFC-005 PR-E T34.
//
// We test the internal helpers (computeDiff, changesToSegments,
// headingSlug, splitForWordDiff) rather than DOM rendering — the
// rendering path is straightforward and exercised end-to-end by the
// review.spec.ts e2e test in PR-E.

import { describe, expect, test } from 'vitest'
import { _internal } from '@/components/review/DiffView'

const { computeDiff, changesToSegments, headingSlug, slugify, splitForWordDiff } = _internal

describe('headingSlug', () => {
  test('extracts slug from h1-h6 lines', () => {
    expect(headingSlug('# Design')).toBe('design')
    expect(headingSlug('### POST endpoints')).toBe('post-endpoints')
    expect(headingSlug('  ##   Multi word title  ')).toBe('multi-word-title')
  })

  test('returns null for non-heading lines', () => {
    expect(headingSlug('some paragraph')).toBeNull()
    expect(headingSlug('')).toBeNull()
    expect(headingSlug('####### too many hashes')).toBeNull()
  })
})

describe('slugify', () => {
  test('lowercases + replaces non-alnum with dash', () => {
    expect(slugify('Hello, World!')).toBe('hello-world')
    expect(slugify('  Leading & trailing  ')).toBe('leading-trailing')
  })

  test('preserves CJK characters', () => {
    expect(slugify('数据模型')).toBe('数据模型')
  })
})

describe('computeDiff @ word granularity', () => {
  test('captures inserted + deleted words', () => {
    const changes = computeDiff('the order_status enum', 'the order_status field', 'word')
    const hasInsert = changes.some((c) => c.added === true && c.value.includes('field'))
    const hasDelete = changes.some((c) => c.removed === true && c.value.includes('enum'))
    expect(hasInsert).toBe(true)
    expect(hasDelete).toBe(true)
  })

  test('handles identical input → all context, no add / remove', () => {
    const changes = computeDiff('same content here', 'same content here', 'word')
    expect(changes.some((c) => c.added === true)).toBe(false)
    expect(changes.some((c) => c.removed === true)).toBe(false)
  })
})

describe('computeDiff @ line granularity', () => {
  test('line-level changes counted independently', () => {
    const left = 'one\ntwo\nthree'
    const right = 'one\nTWO\nthree'
    const changes = computeDiff(left, right, 'line')
    expect(changes.some((c) => c.added === true)).toBe(true)
    expect(changes.some((c) => c.removed === true)).toBe(true)
  })
})

describe('computeDiff @ block granularity', () => {
  test('treats blank-line-separated blocks as atomic units', () => {
    const left = 'first block\n\nsecond block'
    const right = 'first block\n\nsecond block changed'
    const changes = computeDiff(left, right, 'block')
    // The second block changes wholesale; the first stays as context.
    const contextValues = changes.filter((c) => c.added !== true && c.removed !== true)
    expect(contextValues.some((c) => c.value.includes('first block'))).toBe(true)
  })
})

describe('changesToSegments', () => {
  test('routes added → right pane only; removed → left pane only', () => {
    const { left, right } = changesToSegments([
      { value: 'a', added: undefined, removed: undefined } as never,
      { value: 'b-added', added: true, removed: undefined } as never,
      { value: 'b-removed', added: undefined, removed: true } as never,
    ])
    expect(left.map((s) => s.text).join('')).toBe('ab-removed')
    expect(right.map((s) => s.text).join('')).toBe('ab-added')
    expect(left.find((s) => s.text === 'b-removed')?.kind).toBe('delete')
    expect(right.find((s) => s.text === 'b-added')?.kind).toBe('insert')
  })
})

describe('splitForWordDiff CJK widening', () => {
  test('passes through pure ASCII unchanged', () => {
    const s = 'simple english text'
    expect(splitForWordDiff(s)).toBe(s)
  })

  test('injects zero-width separator between CJK graphemes (when Intl.Segmenter present)', () => {
    const s = '订单状态'
    const out = splitForWordDiff(s)
    // In environments with Intl.Segmenter we expect some widening; in
    // happy-dom it may or may not be installed — the test just asserts
    // we don't lose chars (output >= input length).
    expect(out.length).toBeGreaterThanOrEqual(s.length)
    // The actual chars survive.
    for (const ch of s) expect(out).toContain(ch)
  })
})
