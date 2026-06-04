// RFC-081 PR-C — list<markdown> inline wire codec + inline-input detection.
// Multi-line markdown documents are framed by MARKDOWN_DOC_BOUNDARY; these lock
// the split/join round-trip (the property the dispatch + approve paths rely on).

import { describe, expect, test } from 'bun:test'
import {
  splitMarkdownDocs,
  joinMarkdownDocs,
  MARKDOWN_DOC_BOUNDARY,
  isInlineMarkdownListReviewInput,
  isMultiDocReviewInput,
} from '@agent-workflow/shared'

describe('splitMarkdownDocs / joinMarkdownDocs', () => {
  test('round-trips multi-line documents', () => {
    const docs = ['# A\n\nbody a\nline2', '# B\n\n- item\n- item2', 'just text']
    expect(splitMarkdownDocs(joinMarkdownDocs(docs))).toEqual(docs)
  })

  test('split tolerates blank lines around boundaries + drops empty docs', () => {
    const wire = `# One\n\n${MARKDOWN_DOC_BOUNDARY}\n\n# Two\n\n${MARKDOWN_DOC_BOUNDARY}\n   \n`
    expect(splitMarkdownDocs(wire)).toEqual(['# One', '# Two'])
  })

  test('empty / whitespace input → []', () => {
    expect(splitMarkdownDocs('')).toEqual([])
    expect(splitMarkdownDocs('   \n  \n')).toEqual([])
    expect(joinMarkdownDocs([])).toBe('')
  })

  test('single document → no boundary needed', () => {
    expect(splitMarkdownDocs('# Solo\n\nbody')).toEqual(['# Solo\n\nbody'])
    expect(joinMarkdownDocs(['# Solo\n\nbody'])).toBe('# Solo\n\nbody')
  })

  test('a document preserves its internal blank lines (only outer edges trimmed)', () => {
    const docs = ['line1\n\n\nline2']
    expect(splitMarkdownDocs(joinMarkdownDocs(docs))).toEqual(docs)
  })
})

describe('isInlineMarkdownListReviewInput', () => {
  test('list<markdown> is inline; list<path<md>> is not', () => {
    expect(isInlineMarkdownListReviewInput('list<markdown>')).toBe(true)
    expect(isInlineMarkdownListReviewInput('list<path<md>>')).toBe(false)
    expect(isInlineMarkdownListReviewInput('list<path<markdown>>')).toBe(false)
    expect(isInlineMarkdownListReviewInput('markdown')).toBe(false)
    expect(isInlineMarkdownListReviewInput('list<string>')).toBe(false)
  })

  test('both list<markdown> and list<path<md>> are multi-doc review inputs', () => {
    expect(isMultiDocReviewInput('list<markdown>')).toBe(true)
    expect(isMultiDocReviewInput('list<path<md>>')).toBe(true)
  })
})
