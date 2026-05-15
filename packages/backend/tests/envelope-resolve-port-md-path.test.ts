// Locks in the "forgiveness path" in resolvePortContent: when a port's
// outputKinds was never declared as markdown_file but the agent emitted a
// single-line .md path that resolves safely inside the task worktree, we
// auto-read the file body. Reported live by the user on the review detail
// page at /reviews/01KRPE30VQT3R4G24PV3ZAG82D where the upstream agent had
// emitted an absolute path and the doc_version body rendered as a one-line
// path string. The strict markdown_file branch is unchanged — covered by
// envelope-parse-md-edge-cases.test.ts.
//
// If any of these go red, see packages/backend/src/services/envelope.ts:
// tryReadInWorktreeMarkdownPath — silent rewrites here can leak file reads
// outside the worktree or break legitimate string ports that happen to end
// in '.md'.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePortContent } from '../src/services/envelope'
import { ValidationError } from '../src/util/errors'

describe('resolvePortContent forgiveness path (kind=undefined + in-worktree .md)', () => {
  let worktree: string
  let outside: string

  beforeEach(() => {
    worktree = mkdtempSync(join(tmpdir(), 'aw-wt-'))
    outside = mkdtempSync(join(tmpdir(), 'aw-out-'))
  })

  afterEach(() => {
    rmSync(worktree, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  test('kind=undefined + absolute path inside worktree → reads file body', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# Spec\nbody')
    const out = resolvePortContent({
      rawContent: join(worktree, 'docs', 'design.md'),
      worktreePath: worktree,
    })
    expect(out).toBe('# Spec\nbody')
  })

  test('kind=undefined + relative path inside worktree → reads file body', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# rel')
    const out = resolvePortContent({
      rawContent: 'docs/design.md',
      worktreePath: worktree,
    })
    expect(out).toBe('# rel')
  })

  test('kind=string + relative .md path inside worktree → also auto-promotes', () => {
    // 'string' / 'markdown' / undefined all share the forgiveness path; only
    // strict 'markdown_file' bypasses it.
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'a.md'), 'auto')
    expect(
      resolvePortContent({
        rawContent: 'docs/a.md',
        kind: 'string',
        worktreePath: worktree,
      }),
    ).toBe('auto')
  })

  test('kind=undefined + path-shaped string but file does not exist → passthrough', () => {
    const raw = 'does-not-exist.md'
    expect(resolvePortContent({ rawContent: raw, worktreePath: worktree })).toBe(raw)
  })

  test('kind=undefined + absolute path OUTSIDE worktree → passthrough (no read, no throw)', () => {
    writeFileSync(join(outside, 'secrets.md'), 'TOP SECRET')
    const raw = join(outside, 'secrets.md')
    expect(resolvePortContent({ rawContent: raw, worktreePath: worktree })).toBe(raw)
  })

  test('kind=undefined + symlink inside worktree pointing outside → passthrough', () => {
    // realpath() resolves the symlink and the containment recheck rejects it.
    // The strict markdown_file branch follows the symlink (legacy behavior
    // documented in envelope-parse-md-edge-cases.test.ts attack 4); the
    // forgiveness path is stricter precisely because it fires implicitly.
    writeFileSync(join(outside, 'secrets.md'), 'TOP SECRET')
    symlinkSync(join(outside, 'secrets.md'), join(worktree, 'evil.md'))
    expect(
      resolvePortContent({
        rawContent: 'evil.md',
        worktreePath: worktree,
      }),
    ).toBe('evil.md')
  })

  test('kind=undefined + multi-line markdown body containing ".md" → passthrough', () => {
    const body = '# Title\n\nsee design/spec.md for details\n'
    expect(resolvePortContent({ rawContent: body, worktreePath: worktree })).toBe(body)
  })

  test('kind=undefined + single line not ending in .md → passthrough', () => {
    expect(resolvePortContent({ rawContent: 'just a status string', worktreePath: worktree })).toBe(
      'just a status string',
    )
  })

  test('kind=undefined + path points to a directory ending in .md → passthrough', () => {
    mkdirSync(join(worktree, 'weird.md'), { recursive: true })
    expect(
      resolvePortContent({
        rawContent: 'weird.md',
        worktreePath: worktree,
      }),
    ).toBe('weird.md')
  })

  test('kind=undefined + .md path containing traversal that escapes worktree → passthrough', () => {
    const raw = '../escape.md'
    writeFileSync(join(outside, 'escape.md'), 'leaked')
    // Even with the file existing outside, lexical containment fails so we
    // never even attempt the read.
    expect(resolvePortContent({ rawContent: raw, worktreePath: worktree })).toBe(raw)
  })

  test('kind=undefined + empty string → passthrough (no probe)', () => {
    expect(resolvePortContent({ rawContent: '', worktreePath: worktree })).toBe('')
  })

  test('kind=markdown_file + absolute path → STILL throws (strict branch unchanged)', () => {
    mkdirSync(join(worktree, 'docs'), { recursive: true })
    writeFileSync(join(worktree, 'docs', 'design.md'), '# Spec')
    expect(() =>
      resolvePortContent({
        rawContent: join(worktree, 'docs', 'design.md'),
        kind: 'markdown_file',
        worktreePath: worktree,
      }),
    ).toThrow(ValidationError)
  })
})
