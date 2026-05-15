// Locks in RFC-009-T5: computeLineRange — derive 1-based line span from
// char offsets into the canonical doc body. Used by the review sidebar to
// render a "Line N" / "Line N–M" chip next to each comment without
// extending the anchor schema.
//
// We test the pure function (not the React render) because the line-ref
// chip is purely a function of (body, offsetStart, offsetEnd) and the
// route just feeds it. If a future regression breaks the line math, this
// goes red instantly.

import { describe, expect, test } from 'vitest'
import { computeLineRange } from '../src/lib/review/lineRange'

describe('RFC-009-T5 computeLineRange', () => {
  test('single-line selection inside a single-line body returns line 1', () => {
    expect(computeLineRange('Hello world', 0, 5)).toEqual({ start: 1, end: 1 })
  })

  test('selection inside line 3 of a multi-line body returns line 3', () => {
    // 'a\nb\ncc\nd' → line offsets: a=0, b=2, cc=4-5, d=7
    const body = 'a\nb\ncc\nd'
    expect(computeLineRange(body, 4, 6)).toEqual({ start: 3, end: 3 })
  })

  test('selection crossing two lines returns { start, start + 1 }', () => {
    // 'aaa\nbbb' → offsetStart=2 (line 1), offsetEnd=5 (line 2)
    expect(computeLineRange('aaa\nbbb', 2, 5)).toEqual({ start: 1, end: 2 })
  })

  test('CRLF line endings count the same as LF (one break per newline)', () => {
    // 'a\r\nb\r\nc' → \n at index 2 bumps to line 2, \n at 5 bumps to 3
    const body = 'a\r\nb\r\nc'
    expect(computeLineRange(body, 6, 7)).toEqual({ start: 3, end: 3 })
  })

  test('offsetEnd at body.length still resolves to the last line', () => {
    const body = 'a\nb\nc' // 3 lines
    expect(computeLineRange(body, 4, body.length)).toEqual({ start: 3, end: 3 })
  })

  test('empty body returns line 1 regardless of offsets', () => {
    expect(computeLineRange('', 0, 0)).toEqual({ start: 1, end: 1 })
  })

  test('offsetStart past body length clamps to last line', () => {
    const body = 'a\nb'
    expect(computeLineRange(body, 999, 999)).toEqual({ start: 2, end: 2 })
  })
})
