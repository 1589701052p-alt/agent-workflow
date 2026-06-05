// RFC-083 PR-C — assembly + git-backed orchestration.
//  - assembleStructuralDiff: injected in-memory readers, mixes code + manifest
//    files into one artifact (files + dependencyChanges + summary).
//  - computeFromWorktree: end-to-end against a real temp git repo (changed-file
//    enumeration + `git show <ref>:<path>` old side + worktree new side).

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleStructuralDiff } from '../src/services/structuralDiff/assemble'
import { computeFromWorktree } from '../src/services/structuralDiff/gitBackend'
import { runGit } from '../src/util/git'

describe('assembleStructuralDiff — in-memory', () => {
  test('mixes code symbol changes + manifest dependency changes', async () => {
    const oldMap: Record<string, string> = {
      'src/a.ts': 'export class A {\n  foo() { return 1 }\n}\n',
      'package.json': '{"dependencies":{"left":"1"}}',
    }
    const newMap: Record<string, string> = {
      'src/a.ts': 'export class A {\n  foo() { return 2 }\n  bar() { return 3 }\n}\n',
      'package.json': '{"dependencies":{"left":"1","zod":"3"}}',
    }
    const diff = await assembleStructuralDiff({
      taskId: 't1',
      scope: 'task',
      fromRef: 'base',
      toRef: 'WORKTREE',
      changedFiles: ['src/a.ts', 'package.json', 'README.md'],
      readOld: async (p) => oldMap[p] ?? null,
      readNew: async (p) => newMap[p] ?? null,
    })
    expect(diff.engine).toBe('baseline')
    expect(diff.status).toBe('ok')
    // code file present (README.md skipped — unsupported, not code/manifest)
    const codeFile = diff.files.find((f) => f.filePath === 'src/a.ts')
    expect(codeFile).toBeDefined()
    const kinds = codeFile?.changes.map(
      (c) => `${c.changeType} ${(c.after ?? c.before)?.qualifiedName}`,
    )
    expect(kinds).toContain('modified A.foo')
    expect(kinds).toContain('added A.bar')
    expect(diff.files.some((f) => f.filePath === 'README.md')).toBe(false)
    // dependency change
    expect(diff.dependencyChanges.find((d) => d.packageName === 'zod')?.changeType).toBe('added')
    // summary aggregates both
    expect(diff.summary.methods.added).toBe(1)
    expect(diff.summary.methods.modified).toBe(1)
    expect(diff.summary.dependencies.added).toBe(1)
  })
})

describe('computeFromWorktree — real git repo', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true })
  })

  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'aw-rfc083-'))
    dirs.push(dir)
    await runGit(dir, ['init', '-q', '-b', 'main'])
    await runGit(dir, ['config', 'user.email', 't@t.test'])
    await runGit(dir, ['config', 'user.name', 't'])
    return dir
  }

  test('symbol changes + dependency change between HEAD and worktree', async () => {
    const dir = await makeRepo()
    writeFileSync(
      join(dir, 'mod.py'),
      'class Animal:\n    legs = 4\n    def speak(self):\n        return "..."\n',
    )
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\ntokio = "1.0"\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])

    // Uncommitted edits: change method body, add a method, add a new file, add a dep.
    writeFileSync(
      join(dir, 'mod.py'),
      'class Animal:\n    legs = 4\n    def speak(self):\n        return "woof"\n    def walk(self):\n        return "x"\n',
    )
    writeFileSync(join(dir, 'Cargo.toml'), '[dependencies]\ntokio = "1.0"\nserde = "1"\n')
    writeFileSync(join(dir, 'new.go'), 'package m\nfunc Added() int { return 1 }\n')

    const diff = await computeFromWorktree({
      taskId: 't1',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })

    expect(diff.toRef).toBe('WORKTREE')
    const py = diff.files.find((f) => f.filePath === 'mod.py')
    const pyChanges = py?.changes.map(
      (c) => `${c.changeType} ${(c.after ?? c.before)?.qualifiedName}`,
    )
    expect(pyChanges).toContain('modified Animal.speak')
    expect(pyChanges).toContain('added Animal.walk')
    const go = diff.files.find((f) => f.filePath === 'new.go')
    expect(
      go?.changes.some((c) => c.changeType === 'added' && c.after?.qualifiedName === 'Added'),
    ).toBe(true)
    expect(diff.dependencyChanges.find((d) => d.packageName === 'serde')?.changeType).toBe('added')
    expect(diff.summary.dependencies.added).toBe(1)
  })

  test('clean worktree → empty diff', async () => {
    const dir = await makeRepo()
    writeFileSync(join(dir, 'a.py'), 'def f():\n    return 1\n')
    await runGit(dir, ['add', '.'])
    await runGit(dir, ['commit', '-q', '-m', 'init'])
    const diff = await computeFromWorktree({
      taskId: 't',
      scope: 'task',
      worktreePath: dir,
      fromRef: 'HEAD',
    })
    expect(diff.files).toEqual([])
    expect(diff.dependencyChanges).toEqual([])
    expect(diff.summary.files).toBe(0)
  })
})
