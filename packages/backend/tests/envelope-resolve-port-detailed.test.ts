// Locks in resolvePortContentDetailed — the variant of resolvePortContent
// that also reports the worktree-relative file path the body was read from.
//
// dispatchReviewNode uses this to snapshot the source file path onto
// doc_versions.source_file_path so renderCommentsForPrompt can cite the
// file the comments target in the iterate re-run prompt.
//
// If this goes red, see packages/backend/src/services/envelope.ts. The
// security boundary (containment / passthrough behavior) is locked
// separately by envelope-parse-md-edge-cases.test.ts and
// envelope-resolve-port-md-path.test.ts; this file focuses on the
// sourcePath shape every dispatchReviewNode invocation depends on.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortContentDetailed } from '../src/services/envelope'

describe('resolvePortContentDetailed sourcePath', () => {
  let worktree: string
  let outside: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-rpcd-wt-'))
    outside = mkdtempSync(join(tmpdir(), 'aw-rpcd-out-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test('kind=markdown_file + relative path → sourcePath = relative path', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'spec.md'), '# Spec\nbody')
    const result = resolvePortContentDetailed({
      rawContent: 'docs/spec.md',
      kind: 'markdown_file',
      worktreePath: worktree,
    })
    expect(result.body).toBe('# Spec\nbody')
    expect(result.sourcePath).toBe('docs/spec.md')
  })

  test('kind=markdown_file + absolute path inside worktree → sourcePath normalized to relative', () => {
    mkdirSync(join(worktree, 'design'), { recursive: true })
    writeFileSync(join(worktree, 'design', 'spec.md'), '# abs')
    const result = resolvePortContentDetailed({
      rawContent: join(worktree, 'design', 'spec.md'),
      kind: 'markdown_file',
      worktreePath: worktree,
    })
    expect(result.body).toBe('# abs')
    expect(result.sourcePath).toBe('design/spec.md')
  })

  test('forgiveness branch (kind=undefined) + .md file in worktree → sourcePath set', () => {
    mkdirSync(join(worktree, 'notes'), { recursive: true })
    writeFileSync(join(worktree, 'notes', 'todo.md'), 'forgiven')
    const result = resolvePortContentDetailed({
      rawContent: 'notes/todo.md',
      worktreePath: worktree,
    })
    expect(result.body).toBe('forgiven')
    expect(result.sourcePath).toBe('notes/todo.md')
  })

  test('forgiveness branch + absolute .md in worktree → sourcePath normalized to relative', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), 'abs forgiven')
    const result = resolvePortContentDetailed({
      rawContent: join(worktree, 'docs', 'design.md'),
      worktreePath: worktree,
    })
    expect(result.body).toBe('abs forgiven')
    expect(result.sourcePath).toBe('docs/design.md')
  })

  test('kind=markdown + multi-line body → sourcePath undefined, body verbatim', () => {
    const body = '# Title\n\nMulti-line markdown body, not a path.\n'
    const result = resolvePortContentDetailed({
      rawContent: body,
      kind: 'markdown',
      worktreePath: worktree,
    })
    expect(result.body).toBe(body)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + path-shaped string that does not exist → sourcePath undefined', () => {
    const raw = 'does-not-exist.md'
    const result = resolvePortContentDetailed({ rawContent: raw, worktreePath: worktree })
    expect(result.body).toBe(raw)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + absolute .md path OUTSIDE worktree → sourcePath undefined, passthrough', () => {
    writeFileSync(join(outside, 'leak.md'), 'TOP SECRET')
    const raw = join(outside, 'leak.md')
    const result = resolvePortContentDetailed({ rawContent: raw, worktreePath: worktree })
    expect(result.body).toBe(raw)
    expect(result.sourcePath).toBeUndefined()
  })

  test('kind=undefined + symlink inside worktree pointing outside → sourcePath undefined, passthrough', () => {
    writeFileSync(join(outside, 'leak.md'), 'TOP SECRET')
    symlinkSync(join(outside, 'leak.md'), join(worktree, 'evil.md'))
    const result = resolvePortContentDetailed({
      rawContent: 'evil.md',
      worktreePath: worktree,
    })
    expect(result.body).toBe('evil.md')
    expect(result.sourcePath).toBeUndefined()
  })
})
