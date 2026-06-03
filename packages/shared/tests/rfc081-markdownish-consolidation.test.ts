// RFC-081 PR-A — the "markdownish" decision is now a single predicate
// (isReviewableBodyKind in kindParser). These lock that the predicate is the
// source of truth, the handlers delegate to it, the multi-doc detectors use it,
// and isMultiMarkdownUpstream now counts path<md> siblings (the RFC-080 gap).

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isReviewableBodyKind,
  isReviewableBodyKindString,
  parseKind,
  isMultiDocReviewInput,
  isNonMarkdownListReviewInput,
  isMultiMarkdownUpstream,
  getHandlerForParsedKind,
} from '@agent-workflow/shared'

describe('isReviewableBodyKind / isReviewableBodyKindString', () => {
  test('markdown-bodied kinds → true', () => {
    for (const k of ['markdown', 'path<md>', 'path<markdown>', 'markdown_file']) {
      expect(isReviewableBodyKindString(k)).toBe(true)
    }
  })
  test('non-markdown kinds → false', () => {
    for (const k of [
      'string',
      'signal',
      'path<json>',
      'path<*>',
      'list<path<md>>',
      'list<markdown>',
    ]) {
      expect(isReviewableBodyKindString(k)).toBe(false)
    }
  })
  test('unparseable → false', () => {
    expect(isReviewableBodyKindString('list<')).toBe(false)
  })
})

describe('handler.isReviewableBody delegates to the single predicate', () => {
  test('handler agrees with isReviewableBodyKind for every selectable kind', () => {
    for (const k of ['string', 'markdown', 'signal', 'path<md>', 'path<json>', 'list<path<md>>']) {
      const p = parseKind(k)
      expect(getHandlerForParsedKind(p).isReviewableBody(p)).toBe(isReviewableBodyKind(p))
    }
  })
})

describe('multi-document detection uses the predicate', () => {
  test('list<markdownish> → multi-doc; list<non-md> → not', () => {
    expect(isMultiDocReviewInput('list<path<md>>')).toBe(true)
    expect(isMultiDocReviewInput('list<markdown>')).toBe(true)
    expect(isMultiDocReviewInput('list<path<json>>')).toBe(false)
    expect(isNonMarkdownListReviewInput('list<path<json>>')).toBe(true)
    expect(isNonMarkdownListReviewInput('list<markdown>')).toBe(false)
  })
})

describe('isMultiMarkdownUpstream counts path<md> siblings (RFC-081 fix)', () => {
  test('a path<md> sibling now participates in the cascade (was silently dropped)', () => {
    const r = isMultiMarkdownUpstream({
      outputs: [
        { name: 'a', kind: 'path<md>' },
        { name: 'b', kind: 'markdown' },
      ],
      syncOutputsOnIterate: true,
    })
    expect(r.trigger).toBe(true)
    expect(r.markdownPorts.slice().sort()).toEqual(['a', 'b'])
  })
  test('non-markdown siblings do not trigger', () => {
    const r = isMultiMarkdownUpstream({
      outputs: [
        { name: 'a', kind: 'path<json>' },
        { name: 'b', kind: 'string' },
      ],
      syncOutputsOnIterate: true,
    })
    expect(r.trigger).toBe(false)
    expect(r.markdownPorts).toEqual([])
  })
})

describe('RFC-081 source guards — markdownish detection is centralized', () => {
  const read = (p: string) => readFileSync(join(import.meta.dir, '../src', p), 'utf8')

  test('reviewMultiDoc.ts delegates to isReviewableBodyKind (no inline ext check)', () => {
    const src = read('reviewMultiDoc.ts')
    expect(src).toContain('isReviewableBodyKind')
    expect(src).not.toContain("p.ext === 'md'")
  })

  test('schemas/review.ts isMultiMarkdownUpstream uses the predicate (no literal pair)', () => {
    const src = read('schemas/review.ts')
    expect(src).toContain('isReviewableBodyKindString')
    expect(src).not.toContain("o.kind === 'markdown_file'")
  })
})
