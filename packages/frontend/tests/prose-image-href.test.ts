// RFC-008 T1 — resolveImageHref pure function.
//
// Locks the worktree-files proxy rewrite rules so `<Prose>`'s image override
// keeps absolute / data: / blob: / protocol-relative URLs intact and only
// rewrites workspace-relative paths.

import { describe, expect, test } from 'vitest'
import { resolveImageHref } from '@/components/prose/imageHref'

describe('resolveImageHref', () => {
  test('absolute http URLs pass through unchanged', () => {
    expect(resolveImageHref('https://example.com/x.png', 't_1')).toBe('https://example.com/x.png')
  })

  test('data: URIs pass through unchanged', () => {
    const data = 'data:image/png;base64,AAAA'
    expect(resolveImageHref(data, 't_1')).toBe(data)
  })

  test('blob: URLs pass through unchanged', () => {
    expect(resolveImageHref('blob:http://localhost/abc', 't_1')).toBe('blob:http://localhost/abc')
  })

  test('protocol-relative URLs pass through', () => {
    expect(resolveImageHref('//cdn.example.com/x.png', 't_1')).toBe('//cdn.example.com/x.png')
  })

  test('relative path rewrites to worktree-files proxy', () => {
    expect(resolveImageHref('./design/img/x.png', 't_1')).toBe(
      '/api/worktree-files/t_1/design/img/x.png',
    )
  })

  test('absolute-looking leading slash treated as worktree-relative', () => {
    expect(resolveImageHref('/foo/bar.png', 't_1')).toBe('/api/worktree-files/t_1/foo/bar.png')
  })

  test('no taskId → original href returned (broken image visible in preview)', () => {
    expect(resolveImageHref('./x.png', undefined)).toBe('./x.png')
  })

  test('empty taskId → original href returned', () => {
    expect(resolveImageHref('./x.png', '')).toBe('./x.png')
  })

  test('empty href → empty', () => {
    expect(resolveImageHref('', 't_1')).toBe('')
  })
})
