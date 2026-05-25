// RFC-065 T1 — pins the wire shapes for the two worktree-files endpoints.
// Backend parses these schemas before c.json so a mis-typed response is a
// typed error, not a silent shape mismatch on the frontend.

import { describe, expect, test } from 'bun:test'

import {
  WORKTREE_DIR_MAX_ENTRIES,
  WORKTREE_FILE_MAX_BYTES,
  worktreeFileResponseSchema,
  worktreeTreeEntrySchema,
  worktreeTreeResponseSchema,
} from '../src/worktree-files'

describe('worktree-files schemas', () => {
  test('constants pin protocol limits (must not drift silently)', () => {
    expect(WORKTREE_FILE_MAX_BYTES).toBe(2 * 1024 * 1024)
    expect(WORKTREE_DIR_MAX_ENTRIES).toBe(5000)
  })

  test('tree entry parses file/dir kinds with size semantics', () => {
    expect(worktreeTreeEntrySchema.parse({ name: 'foo.ts', kind: 'file', size: 120 })).toEqual({
      name: 'foo.ts',
      kind: 'file',
      size: 120,
    })
    expect(worktreeTreeEntrySchema.parse({ name: 'src', kind: 'directory', size: null })).toEqual({
      name: 'src',
      kind: 'directory',
      size: null,
    })
  })

  test('tree entry rejects empty name, unknown kind, negative size', () => {
    expect(() => worktreeTreeEntrySchema.parse({ name: '', kind: 'file', size: 0 })).toThrow()
    expect(() => worktreeTreeEntrySchema.parse({ name: 'foo', kind: 'symlink', size: 0 })).toThrow()
    expect(() => worktreeTreeEntrySchema.parse({ name: 'foo', kind: 'file', size: -1 })).toThrow()
  })

  test('tree response parses + rejects missing truncated flag', () => {
    const ok = worktreeTreeResponseSchema.parse({
      path: 'packages',
      entries: [{ name: 'shared', kind: 'directory', size: null }],
      truncated: false,
    })
    expect(ok.truncated).toBe(false)
    expect(() =>
      worktreeTreeResponseSchema.parse({
        path: 'packages',
        entries: [],
      }),
    ).toThrow()
  })

  test('file response parses oversized + normal branches; rejects negative size', () => {
    expect(
      worktreeFileResponseSchema.parse({
        path: 'README.md',
        size: 42,
        oversized: false,
        content: 'hello',
      }),
    ).toEqual({ path: 'README.md', size: 42, oversized: false, content: 'hello' })
    expect(
      worktreeFileResponseSchema.parse({
        path: 'huge.bin',
        size: 1024 * 1024 * 50,
        oversized: true,
        content: '',
      }).oversized,
    ).toBe(true)
    expect(() =>
      worktreeFileResponseSchema.parse({
        path: 'x',
        size: -1,
        oversized: false,
        content: '',
      }),
    ).toThrow()
  })
})
