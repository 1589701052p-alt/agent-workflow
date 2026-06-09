// RFC-079 / RFC-081 — edge-case regression locks for review multi-document oracles.
//
// Supplements packages/shared/tests/review-multidoc-shared.test.ts, which only
// exercises well-formed inputs. This file locks the BOUNDARY behaviors that a
// refactor could silently break:
//   GAP 1/2/3 — extractDocTitle: heading-shaped lines the ATX regex REJECTS
//     (bare hashes, '#NoSpace', 7 hashes, 4-space indent) must fall through to
//     the first-non-empty-line strategy; plus the 3-space / h6 upper bounds and
//     the basename() backslash + trailing-slash separator handling.
//   GAP 4 — acceptedSubsetPaths/computeAcceptedSubset: null/undefined itemIndex
//     coerces to 0 via '?? 0' and clusters at the front in stable input order;
//     duplicate itemPaths are RETAINED (no dedup) — load-bearing for the
//     downstream list<path<md>> fanout.
//   GAP 5 — reviewApprovedPortName/isMultiDocReviewInput: the 'list<markdown_file>'
//     alias must fold (markdown_file → path<md>) and still drive the 'accepted'
//     multi-doc outlet, while single 'markdown_file' stays 'approved_doc'.
// If any of these go red, the multi-document semantics / kind-alias folding drifted.

import { describe, expect, test } from 'bun:test'

import {
  acceptedSubsetPaths,
  computeAcceptedSubset,
  extractDocTitle,
  isMultiDocReviewInput,
  reviewApprovedPortName,
  type SelectableDoc,
} from '../src/reviewMultiDoc'

describe('extractDocTitle — hash-only / no-space heading-shaped lines (GAP 1)', () => {
  test('bare hashes are not an ATX heading; they win as first non-empty line', () => {
    // '###' has no whitespace + title after the hashes → regex.exec === null →
    // falls through to the first-non-empty-line fallback, which returns '###'
    // itself (it precedes 'real line').
    expect(extractDocTitle('###\nreal line', 'a.md')).toBe('###')
  })

  test("'#NoSpace' (no space after hash) is not ATX → returned literally", () => {
    expect(extractDocTitle('#NoSpace\nbody', 'a.md')).toBe('#NoSpace')
  })

  test('trimmed hash-only line is still the first non-empty line, not the later title', () => {
    // '###   ' technically matches the regex but m[1] is whitespace-only, so the
    // m[1].trim().length > 0 guard rejects it; first-non-empty fallback trims it to '###'.
    expect(extractDocTitle('   \n###   \nThe Title', 'a.md')).toBe('###')
  })
})

describe('extractDocTitle — indent + hash-count ATX boundaries (GAP 2)', () => {
  test('4-space indent exceeds \\s{0,3} → not a heading → trimmed first line', () => {
    expect(extractDocTitle('    # Indented\nplain', 'a.md')).toBe('# Indented')
  })

  test('exactly 3 leading spaces is still a valid ATX heading', () => {
    expect(extractDocTitle('   # Three Spaces\nbody', 'a.md')).toBe('Three Spaces')
  })

  test('h6 (######) is the max heading level', () => {
    expect(extractDocTitle('###### Six\n', 'a.md')).toBe('Six')
  })

  test('7 hashes is not a heading → first non-empty line returned literally', () => {
    expect(extractDocTitle('####### Seven\nfallback', 'a.md')).toBe('####### Seven')
  })
})

describe('extractDocTitle — basename fallback separators (GAP 3)', () => {
  test('backslash path → last backslash segment', () => {
    expect(extractDocTitle('', 'cases\\sub\\tc_9.md')).toBe('tc_9.md')
  })

  test('trailing slash is stripped, then last segment taken', () => {
    expect(extractDocTitle('', 'cases/sub/')).toBe('sub')
  })

  test('no separator → whole string', () => {
    expect(extractDocTitle('', 'plainname')).toBe('plainname')
  })
})

describe('acceptedSubsetPaths / computeAcceptedSubset — null index + duplicates (GAP 4)', () => {
  test('null/undefined itemIndex coerce to 0 and keep input order (stable sort)', () => {
    const rows: SelectableDoc[] = [
      { itemIndex: null, itemPath: 'n.md', selection: 'accepted' },
      { itemIndex: 2, itemPath: 'b.md', selection: 'accepted' },
      { itemIndex: undefined, itemPath: 'u.md', selection: 'accepted' },
    ]
    expect(acceptedSubsetPaths(rows)).toEqual(['n.md', 'u.md', 'b.md'])
  })

  test('duplicate itemPaths are retained (no dedup)', () => {
    const rows: SelectableDoc[] = [
      { itemIndex: 0, itemPath: 'dup.md', selection: 'accepted' },
      { itemIndex: 1, itemPath: 'dup.md', selection: 'accepted' },
    ]
    expect(acceptedSubsetPaths(rows)).toEqual(['dup.md', 'dup.md'])
  })

  test('wire form keeps duplicates newline-joined', () => {
    const rows: SelectableDoc[] = [
      { itemIndex: 0, itemPath: 'dup.md', selection: 'accepted' },
      { itemIndex: 1, itemPath: 'dup.md', selection: 'accepted' },
    ]
    expect(computeAcceptedSubset(rows)).toBe('dup.md\ndup.md')
  })
})

describe('reviewApprovedPortName / isMultiDocReviewInput — markdown_file alias (GAP 5)', () => {
  test("list<markdown_file> folds to a markdownish list → 'accepted'", () => {
    expect(reviewApprovedPortName('list<markdown_file>')).toBe('accepted')
  })

  test('list<markdown_file> drives multi-doc mode', () => {
    expect(isMultiDocReviewInput('list<markdown_file>')).toBe(true)
  })

  test("single markdown_file folds to path<md> (not a list) → 'approved_doc'", () => {
    expect(reviewApprovedPortName('markdown_file')).toBe('approved_doc')
  })
})
