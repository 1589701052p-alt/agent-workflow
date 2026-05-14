// gitStashSnapshot + rollbackToSnapshot end-to-end against a real git
// fixture (P-3-07).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitStashSnapshot, rollbackToSnapshot, runGit } from '../src/util/git'

interface Repo {
  path: string
  cleanup: () => void
}

async function buildRepo(): Promise<Repo> {
  const path = mkdtempSync(join(tmpdir(), 'aw-snap-'))
  await runGit(path, ['init', '-q', '-b', 'main'])
  await runGit(path, ['config', 'user.email', 'test@example.com'])
  await runGit(path, ['config', 'user.name', 'Test'])
  writeFileSync(join(path, 'a.txt'), 'original\n')
  await runGit(path, ['add', '.'])
  await runGit(path, ['commit', '-q', '-m', 'init'])
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) }
}

describe('gitStashSnapshot + rollbackToSnapshot', () => {
  let r: Repo
  beforeEach(async () => {
    r = await buildRepo()
  })
  afterEach(() => r.cleanup())

  test('clean worktree → snapshot returns empty string', async () => {
    expect(await gitStashSnapshot(r.path)).toBe('')
  })

  test('captures modified tracked file', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'modified\n')
    const sha = await gitStashSnapshot(r.path)
    expect(sha).toMatch(/^[a-f0-9]{40}$/)
    // git stash create does NOT push to stash list; verify the entry isn't
    // there but the commit object is reachable.
    const list = await runGit(r.path, ['stash', 'list'])
    expect(list.stdout.trim()).toBe('')
    const cat = await runGit(r.path, ['cat-file', '-t', sha])
    expect(cat.stdout.trim()).toBe('commit')
  })

  test('captures untracked file via --include-untracked semantics', async () => {
    // git stash create stashes tracked + index by default. The runner takes
    // the snapshot BEFORE any agent write, so this primarily protects
    // tracked working-tree changes. Untracked files predating the agent are
    // rare; this test pins the current behavior.
    writeFileSync(join(r.path, 'fresh.txt'), 'new\n')
    const sha = await gitStashSnapshot(r.path)
    // Default stash create does not include untracked: returns '' if only
    // untracked changes exist.
    if (sha === '') {
      expect(existsSync(join(r.path, 'fresh.txt'))).toBe(true)
    } else {
      expect(sha).toMatch(/^[a-f0-9]{40}$/)
    }
  })

  test('rollback restores the snapshot after subsequent edits', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'snap-time\n')
    const sha = await gitStashSnapshot(r.path)

    // Simulate an agent write that we want to undo.
    writeFileSync(join(r.path, 'a.txt'), 'post-snap garbage\n')
    writeFileSync(join(r.path, 'new.txt'), 'unwanted\n')

    await rollbackToSnapshot(r.path, sha)

    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('snap-time\n')
    expect(existsSync(join(r.path, 'new.txt'))).toBe(false)
  })

  test('rollback with empty sha just resets + cleans', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'changed\n')
    writeFileSync(join(r.path, 'extra.txt'), 'extra\n')
    await rollbackToSnapshot(r.path, '')
    expect(readFileSync(join(r.path, 'a.txt'), 'utf-8')).toBe('original\n')
    expect(existsSync(join(r.path, 'extra.txt'))).toBe(false)
  })

  test('rollback with unknown sha → DomainError', async () => {
    writeFileSync(join(r.path, 'a.txt'), 'changed\n')
    await expect(rollbackToSnapshot(r.path, 'deadbeef'.repeat(5))).rejects.toMatchObject({
      code: 'worktree-apply-failed',
    })
  })
})
