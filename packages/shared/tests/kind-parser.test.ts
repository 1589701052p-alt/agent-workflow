// RFC-060 PR-A — kindParser 单元测试。
//
// 锁住的契约：
// 1. 三种合法形态：base / path<ext> / list<...> 含嵌套。
// 2. 'markdown_file' 是 'path<md>' 的别名（parse 时折叠，stringify 永不回滚）。
// 3. malformed 输入抛 KindParseError。
// 4. round-trip：parseKind(stringifyKind(p)) deep-equals p。

import { describe, expect, test } from 'bun:test'
import {
  KindParseError,
  isValidKindString,
  kindsEqual,
  parseKind,
  stringifyKind,
  tryParseKind,
} from '../src/kindParser'

describe('parseKind — base kinds', () => {
  test('parses simple base names', () => {
    expect(parseKind('string')).toEqual({ kind: 'base', name: 'string' })
    expect(parseKind('markdown')).toEqual({ kind: 'base', name: 'markdown' })
    expect(parseKind('signal')).toEqual({ kind: 'base', name: 'signal' })
  })

  test('accepts underscores and digits in base names', () => {
    expect(parseKind('foo_bar')).toEqual({ kind: 'base', name: 'foo_bar' })
    expect(parseKind('v2')).toEqual({ kind: 'base', name: 'v2' })
  })

  test('rejects leading digit / capital / dot', () => {
    expect(() => parseKind('2foo')).toThrow(KindParseError)
    expect(() => parseKind('Foo')).toThrow(KindParseError)
    expect(() => parseKind('foo.bar')).toThrow(KindParseError)
  })
})

describe('parseKind — markdown_file alias', () => {
  test("'markdown_file' folds into path<md>", () => {
    expect(parseKind('markdown_file')).toEqual({ kind: 'path', ext: 'md' })
  })

  test("stringify never emits 'markdown_file'", () => {
    expect(stringifyKind(parseKind('markdown_file'))).toBe('path<md>')
  })
})

describe('parseKind — path<ext>', () => {
  test('path<*> wildcard', () => {
    expect(parseKind('path<*>')).toEqual({ kind: 'path', ext: '*' })
  })

  test('path<md> / path<markdown> / path<json>', () => {
    expect(parseKind('path<md>')).toEqual({ kind: 'path', ext: 'md' })
    expect(parseKind('path<markdown>')).toEqual({ kind: 'path', ext: 'markdown' })
    expect(parseKind('path<json>')).toEqual({ kind: 'path', ext: 'json' })
  })

  test('rejects empty / invalid ext', () => {
    expect(() => parseKind('path<>')).toThrow(KindParseError)
    expect(() => parseKind('path<.md>')).toThrow(KindParseError)
    expect(() => parseKind('path<MD>')).toThrow(KindParseError)
    expect(() => parseKind('path<foo bar>')).toThrow(KindParseError)
  })
})

describe('parseKind — list<T>', () => {
  test('list<base>', () => {
    expect(parseKind('list<string>')).toEqual({
      kind: 'list',
      item: { kind: 'base', name: 'string' },
    })
  })

  test('list<path<md>>', () => {
    expect(parseKind('list<path<md>>')).toEqual({
      kind: 'list',
      item: { kind: 'path', ext: 'md' },
    })
  })

  test('list<path<*>>', () => {
    expect(parseKind('list<path<*>>')).toEqual({
      kind: 'list',
      item: { kind: 'path', ext: '*' },
    })
  })

  test('list<list<string>> nested', () => {
    expect(parseKind('list<list<string>>')).toEqual({
      kind: 'list',
      item: { kind: 'list', item: { kind: 'base', name: 'string' } },
    })
  })

  test('list with markdown_file alias inside', () => {
    expect(parseKind('list<markdown_file>')).toEqual({
      kind: 'list',
      item: { kind: 'path', ext: 'md' },
    })
  })

  test('rejects empty list body / unbalanced brackets', () => {
    expect(() => parseKind('list<>')).toThrow(KindParseError)
    expect(() => parseKind('list<int>>')).toThrow(KindParseError)
    expect(() => parseKind('list<<int>')).toThrow(KindParseError)
    expect(() => parseKind('list<path<md>')).toThrow(KindParseError)
  })
})

describe('parseKind — malformed', () => {
  test('empty / whitespace-only string', () => {
    expect(() => parseKind('')).toThrow(KindParseError)
    expect(() => parseKind('   ')).toThrow(KindParseError)
  })

  test('non-string input', () => {
    // @ts-expect-error — runtime guard against JSON.parse leaks
    expect(() => parseKind(null)).toThrow(KindParseError)
    // @ts-expect-error
    expect(() => parseKind(42)).toThrow(KindParseError)
  })

  test('unknown parametric head', () => {
    expect(() => parseKind('foo<bar>')).toThrow(KindParseError)
  })

  test("missing '>' at end", () => {
    expect(() => parseKind('list<int')).toThrow(KindParseError)
    expect(() => parseKind('path<md')).toThrow(KindParseError)
  })
})

describe('stringifyKind + round-trip', () => {
  test('round-trip preserves structure', () => {
    const samples = [
      'string',
      'markdown',
      'signal',
      'path<*>',
      'path<md>',
      'path<markdown>',
      'list<string>',
      'list<path<md>>',
      'list<list<path<*>>>',
    ]
    for (const s of samples) {
      const parsed = parseKind(s)
      expect(stringifyKind(parsed)).toBe(s)
      expect(parseKind(stringifyKind(parsed))).toEqual(parsed)
    }
  })

  test('markdown_file folds + canonical output is path<md>', () => {
    expect(stringifyKind(parseKind('markdown_file'))).toBe('path<md>')
    // alias output is byte-equal regardless of how we wrote it on disk
    expect(stringifyKind(parseKind('path<md>'))).toBe('path<md>')
  })
})

describe('tryParseKind / isValidKindString', () => {
  test('tryParseKind returns null on malformed', () => {
    expect(tryParseKind('list<>')).toBeNull()
    expect(tryParseKind('')).toBeNull()
  })

  test('tryParseKind returns ParsedKind on good input', () => {
    expect(tryParseKind('path<md>')).toEqual({ kind: 'path', ext: 'md' })
  })

  test('isValidKindString tracks tryParseKind', () => {
    expect(isValidKindString('path<md>')).toBe(true)
    expect(isValidKindString('markdown_file')).toBe(true)
    expect(isValidKindString('list<>')).toBe(false)
  })
})

describe('kindsEqual', () => {
  test('structural equality across alias normalization', () => {
    expect(kindsEqual(parseKind('markdown_file'), parseKind('path<md>'))).toBe(true)
    expect(kindsEqual(parseKind('list<path<md>>'), parseKind('list<markdown_file>'))).toBe(true)
  })

  test('different exts / heads not equal', () => {
    expect(kindsEqual(parseKind('path<md>'), parseKind('path<json>'))).toBe(false)
    expect(kindsEqual(parseKind('list<string>'), parseKind('string'))).toBe(false)
  })
})
