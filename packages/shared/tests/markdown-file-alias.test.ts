// RFC-060 PR-A — `markdown_file` literal compatibility matrix.
//
// PR-A goal: keep the legacy literal 'markdown_file' fully valid as an
// AgentOutputKind string while introducing `path<md>` as the new canonical
// form. Existing agent.md / workflow YAML / DB rows storing
// 'markdown_file' round-trip unchanged; new code can write `path<md>` and
// be semantically identical.
//
// Locks the contract:
//   1. Schema accepts 'markdown_file' (round-trip preserves the literal).
//   2. parseKind folds 'markdown_file' → path<md>.
//   3. stringifyKind never emits 'markdown_file' (canonical output =
//      'path<md>') — once we parse and re-stringify, the repository
//      converges on a single representation.
//   4. list<markdown_file> nested alias works.
//   5. kindsEqual treats 'markdown_file' and 'path<md>' as semantically
//      equivalent — the validator + dispatch code paths reaching for
//      kind equality see them as the same kind.

import { describe, expect, test } from 'bun:test'
import { kindsEqual, parseKind, stringifyKind } from '../src/kindParser'
import { AgentOutputKindSchema } from '../src/schemas/review'

describe('markdown_file alias — schema acceptance', () => {
  test("AgentOutputKindSchema.parse('markdown_file') round-trips literal", () => {
    expect(AgentOutputKindSchema.parse('markdown_file')).toBe('markdown_file')
  })

  test("AgentOutputKindSchema.parse('path<md>') round-trips literal", () => {
    expect(AgentOutputKindSchema.parse('path<md>')).toBe('path<md>')
  })
})

describe('markdown_file alias — parseKind fold', () => {
  test("parseKind('markdown_file') → { kind: 'path', ext: 'md' }", () => {
    expect(parseKind('markdown_file')).toEqual({ kind: 'path', ext: 'md' })
  })

  test("parseKind('path<md>') → { kind: 'path', ext: 'md' } (same shape)", () => {
    expect(parseKind('path<md>')).toEqual({ kind: 'path', ext: 'md' })
  })
})

describe('markdown_file alias — canonical stringify', () => {
  test("stringifyKind never emits 'markdown_file'", () => {
    expect(stringifyKind(parseKind('markdown_file'))).toBe('path<md>')
  })

  test('round-tripping via parse → stringify converges on path<md>', () => {
    expect(stringifyKind(parseKind('markdown_file'))).toBe(stringifyKind(parseKind('path<md>')))
  })
})

describe('markdown_file alias — list nesting', () => {
  test('list<markdown_file> folds inner item to path<md>', () => {
    expect(parseKind('list<markdown_file>')).toEqual({
      kind: 'list',
      item: { kind: 'path', ext: 'md' },
    })
  })

  test('list<markdown_file> canonical stringify is list<path<md>>', () => {
    expect(stringifyKind(parseKind('list<markdown_file>'))).toBe('list<path<md>>')
  })

  test('AgentOutputKindSchema accepts list<markdown_file> literal', () => {
    expect(AgentOutputKindSchema.parse('list<markdown_file>')).toBe('list<markdown_file>')
  })
})

describe('markdown_file alias — semantic equivalence', () => {
  test('kindsEqual sees markdown_file and path<md> as equal', () => {
    expect(kindsEqual(parseKind('markdown_file'), parseKind('path<md>'))).toBe(true)
  })

  test('kindsEqual sees list<markdown_file> and list<path<md>> as equal', () => {
    expect(kindsEqual(parseKind('list<markdown_file>'), parseKind('list<path<md>>'))).toBe(true)
  })

  test('kindsEqual does NOT collapse path<md> with path<markdown> (different ext name)', () => {
    // ext names are kept distinct because future tooling may want to
    // distinguish .md-strict from .md-or-.markdown-flexible. Current
    // PathHandler accepts the same suffix list for both; equality
    // remains literal so the validator doesn't silently merge them.
    expect(kindsEqual(parseKind('path<md>'), parseKind('path<markdown>'))).toBe(false)
  })
})
