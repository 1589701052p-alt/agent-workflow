// RFC-019: parseSkillMarkdown locks the SKILL.md → typed-shape mapping used
// by the ZIP batch importer. Anything not (name|description) lands in
// frontmatterExtra so we round-trip user-authored frontmatter.

import { describe, expect, test } from 'bun:test'
import { parseSkillMarkdown } from '../src/skill-md'

describe('parseSkillMarkdown', () => {
  test('happy path: name + description + body', () => {
    const r = parseSkillMarkdown('---\nname: foo\ndescription: A skill\n---\nBody line.\n')
    expect(r.hadFrontmatter).toBe(true)
    expect(r.name).toBe('foo')
    expect(r.description).toBe('A skill')
    expect(r.bodyMd).toBe('Body line.')
    expect(r.frontmatterExtra).toEqual({})
    expect(r.warnings).toEqual([])
  })

  test('unknown frontmatter keys → frontmatterExtra', () => {
    const r = parseSkillMarkdown(
      '---\nname: foo\ndescription: x\nauthor: alice\ntags: [a, b]\n---\nbody\n',
    )
    expect(r.frontmatterExtra).toEqual({ author: 'alice', tags: ['a', 'b'] })
  })

  test('no frontmatter: whole input becomes bodyMd', () => {
    const r = parseSkillMarkdown('just a body\n')
    expect(r.hadFrontmatter).toBe(false)
    expect(r.name).toBeUndefined()
    expect(r.description).toBe('')
    expect(r.bodyMd).toBe('just a body')
  })

  test('YAML parse failure: warning + empty data', () => {
    const r = parseSkillMarkdown('---\n: : :\n---\nbody\n')
    expect(r.hadFrontmatter).toBe(true)
    expect(r.warnings.some((w) => w.startsWith('yaml-parse-failed'))).toBe(true)
    expect(r.name).toBeUndefined()
    expect(r.description).toBe('')
    expect(r.bodyMd).toBe('body')
  })

  test('top-level YAML is an array: warning + empty data', () => {
    const r = parseSkillMarkdown('---\n- one\n- two\n---\nbody\n')
    expect(r.warnings.some((w) => w.startsWith('frontmatter-not-object'))).toBe(true)
    expect(r.bodyMd).toBe('body')
  })

  test('non-string name → warning + undefined', () => {
    const r = parseSkillMarkdown('---\nname: 42\ndescription: ok\n---\nbody\n')
    expect(r.name).toBeUndefined()
    expect(r.description).toBe('ok')
    expect(r.warnings.some((w) => w.includes('name'))).toBe(true)
  })

  test('non-string description → warning + empty', () => {
    const r = parseSkillMarkdown('---\nname: foo\ndescription: [1,2]\n---\nbody\n')
    expect(r.description).toBe('')
    expect(r.warnings.some((w) => w.includes('description'))).toBe(true)
  })

  test('empty frontmatter block: defaults', () => {
    const r = parseSkillMarkdown('---\n\n---\nbody\n')
    expect(r.hadFrontmatter).toBe(true)
    expect(r.name).toBeUndefined()
    expect(r.description).toBe('')
    expect(r.bodyMd).toBe('body')
  })

  test('body retains internal blank lines but trims outer whitespace', () => {
    const r = parseSkillMarkdown('---\nname: foo\n---\n\n\nfirst\n\nsecond\n\n')
    expect(r.bodyMd).toBe('first\n\nsecond')
  })

  test('CRLF line endings parse correctly', () => {
    const r = parseSkillMarkdown('---\r\nname: foo\r\ndescription: bar\r\n---\r\nbody\r\n')
    expect(r.name).toBe('foo')
    expect(r.description).toBe('bar')
    expect(r.bodyMd).toBe('body')
  })
})
