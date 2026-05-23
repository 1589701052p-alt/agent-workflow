// RFC-060 PR-A — shardingRegistry behaviour tests.
//
// Locks:
//  - Default registrations: path<*> / path<md> / path<markdown> all use
//    the path string itself as shardKey.
//  - Fallback chain: exact kind → path<*> for path-family → 0-based index.
//  - registerKeyOf overrides existing registration (idempotent overwrite).
//  - clearShardingRegistry restores defaults.

import { afterEach, describe, expect, test } from 'bun:test'
import { parseKind } from '../src/kindParser'
import { clearShardingRegistry, registerKeyOf, resolveKeyOf } from '../src/shardingRegistry'

afterEach(() => {
  // Restore default registrations between tests so registerKeyOf inside
  // one test doesn't bleed into the next.
  clearShardingRegistry()
})

describe('resolveKeyOf — defaults', () => {
  test('path<md> → path itself', () => {
    const keyOf = resolveKeyOf(parseKind('path<md>'))
    expect(keyOf('docs/intro.md', 0, parseKind('path<md>'))).toBe('docs/intro.md')
  })

  test('path<*> → path itself', () => {
    const keyOf = resolveKeyOf(parseKind('path<*>'))
    expect(keyOf('src/foo.ts', 3, parseKind('path<*>'))).toBe('src/foo.ts')
  })

  test('path<markdown> → path itself', () => {
    const keyOf = resolveKeyOf(parseKind('path<markdown>'))
    expect(keyOf('a.markdown', 0, parseKind('path<markdown>'))).toBe('a.markdown')
  })

  test('path<json> falls back to path<*> registration → path itself', () => {
    const keyOf = resolveKeyOf(parseKind('path<json>'))
    expect(keyOf('data/config.json', 7, parseKind('path<json>'))).toBe('data/config.json')
  })

  test('base string → 0-based index fallback', () => {
    const keyOf = resolveKeyOf(parseKind('string'))
    expect(keyOf('any', 0, parseKind('string'))).toBe('0')
    expect(keyOf('any', 5, parseKind('string'))).toBe('5')
  })

  test('list<string> as item kind → 0-based index fallback', () => {
    const keyOf = resolveKeyOf(parseKind('list<string>'))
    expect(keyOf('alpha\nbeta', 2, parseKind('list<string>'))).toBe('2')
  })
})

describe('registerKeyOf — overrides', () => {
  test('overrides path<md> with a slug extractor', () => {
    registerKeyOf(parseKind('path<md>'), (item) => item.split('/').pop() ?? item)
    const keyOf = resolveKeyOf(parseKind('path<md>'))
    expect(keyOf('docs/intro.md', 0, parseKind('path<md>'))).toBe('intro.md')
  })

  test('registers a new keyOf for an arbitrary base kind', () => {
    registerKeyOf(parseKind('markdown'), (item) => item.slice(0, 8))
    const keyOf = resolveKeyOf(parseKind('markdown'))
    expect(keyOf('This is a long markdown body', 0, parseKind('markdown'))).toBe('This is ')
  })
})

describe('clearShardingRegistry', () => {
  test('reinstalls defaults', () => {
    registerKeyOf(parseKind('path<md>'), () => 'override')
    expect(resolveKeyOf(parseKind('path<md>'))('docs/intro.md', 0, parseKind('path<md>'))).toBe(
      'override',
    )
    clearShardingRegistry()
    expect(resolveKeyOf(parseKind('path<md>'))('docs/intro.md', 0, parseKind('path<md>'))).toBe(
      'docs/intro.md',
    )
  })
})

describe('resolveKeyOf — trims whitespace on path items', () => {
  test('path<md> trims trailing whitespace from item', () => {
    const keyOf = resolveKeyOf(parseKind('path<md>'))
    expect(keyOf('  docs/intro.md  ', 0, parseKind('path<md>'))).toBe('docs/intro.md')
  })
})
