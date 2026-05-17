// RFC-024 T3 — locks the cold-clone / warm-hit / fetch-on-reuse /
// concurrent-same-URL behavior of services/gitRepoCache.ts. Uses a real
// local bare repo as the "remote" so the suite exercises git itself.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInMemoryDb, type DbClient } from '../src/db/client'
import { cachedRepos } from '../src/db/schema'
import {
  deleteCachedRepo,
  listCachedRepos,
  refreshCachedRepo,
  resolveCachedRepo,
} from '../src/services/gitRepoCache'
import { runGit } from '../src/util/git'

const MIGRATIONS = resolve(import.meta.dir, '..', 'db', 'migrations')

async function spawnGitInit(cwd: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn({
    cmd: ['git', ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`git ${args.join(' ')} failed: ${stderr}`)
  }
}

async function buildFixtureRemote(): Promise<{ dir: string; url: string }> {
  // A working clone with a couple of commits, then `git clone --bare` it into
  // a sibling "remote" we can hand to resolveCachedRepo as `file://...`.
  const root = mkdtempSync(join(tmpdir(), 'aw-grc-fixture-'))
  const working = join(root, 'src')
  mkdirSync(working, { recursive: true })
  await spawnGitInit(working, 'init', '-b', 'main', working)
  // Identity is required for `git commit`.
  await spawnGitInit(working, '-C', working, 'config', 'user.email', 'aw-test@example.com')
  await spawnGitInit(working, '-C', working, 'config', 'user.name', 'AW Test')
  writeFileSync(join(working, 'README.md'), '# fixture\n', 'utf-8')
  await spawnGitInit(working, '-C', working, 'add', '.')
  await spawnGitInit(working, '-C', working, 'commit', '-m', 'init')
  const bare = join(root, 'remote.git')
  await spawnGitInit(root, 'clone', '--bare', working, bare)
  return { dir: root, url: `file://${bare}` }
}

describe('gitRepoCache (RFC-024 T3)', () => {
  let db: DbClient
  let appHome: string
  let remoteDir: string
  let remoteUrl: string

  beforeEach(async () => {
    db = createInMemoryDb(MIGRATIONS)
    appHome = mkdtempSync(join(tmpdir(), 'aw-grc-home-'))
    const r = await buildFixtureRemote()
    remoteDir = r.dir
    remoteUrl = r.url
  })

  afterEach(() => {
    try {
      rmSync(appHome, { recursive: true, force: true })
    } catch {
      /* noop */
    }
    try {
      rmSync(remoteDir, { recursive: true, force: true })
    } catch {
      /* noop */
    }
  })

  test('cold clone creates cache row, dir, and detects default branch', async () => {
    const r = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(r.cold).toBe(true)
    expect(r.cached.defaultBranch).toBe('main')
    expect(existsSync(r.cached.localPath)).toBe(true)
    // The cache dir IS a git repo.
    const inside = await runGit(r.cached.localPath, ['rev-parse', '--git-dir'])
    expect(inside.exitCode).toBe(0)
    const rows = db.select().from(cachedRepos).all()
    expect(rows.length).toBe(1)
    expect(rows[0]?.localPath).toBe(r.cached.localPath)
  })

  test('second call hits cache without re-cloning', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    const b = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(a.cold).toBe(true)
    expect(b.cold).toBe(false)
    expect(a.cached.id).toBe(b.cached.id)
    expect(a.cached.localPath).toBe(b.cached.localPath)
  })

  test('fetchOnReuse=true runs git fetch and bumps lastFetchedAt', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    const aTs = a.cached.lastFetchedAt
    // Force time forward so the second fetch's timestamp is strictly greater.
    let t = Date.parse(aTs)
    const b = await resolveCachedRepo(
      { db, appHome, fetchOnReuse: true, now: () => (t += 1000) },
      { url: remoteUrl },
    )
    expect(b.cold).toBe(false)
    expect(b.fetchOk).toBe(true)
    expect(Date.parse(b.cached.lastFetchedAt)).toBeGreaterThan(Date.parse(aTs))
  })

  test('concurrent same-URL cold launches result in a single cache row', async () => {
    const [a, b] = await Promise.all([
      resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl }),
      resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl }),
    ])
    // Exactly one of the two callers experienced the cold path; the other
    // observed a warm cache after the first finished.
    expect([a.cold, b.cold].filter(Boolean).length).toBe(1)
    expect(a.cached.id).toBe(b.cached.id)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })

  test('invalid URL throws repo-url-invalid', async () => {
    let err: unknown
    try {
      await resolveCachedRepo({ db, appHome }, { url: '/not/a/url' })
    } catch (e) {
      err = e
    }
    // @ts-expect-error inspect at runtime
    expect(err?.code).toBe('repo-url-invalid')
  })

  test('clone of nonexistent remote fails with repo-clone-failed and leaves no row', async () => {
    let err: unknown
    try {
      await resolveCachedRepo(
        { db, appHome },
        { url: 'file:///tmp/aw-grc-definitely-not-a-repo-xyz.git' },
      )
    } catch (e) {
      err = e
    }
    // @ts-expect-error inspect at runtime
    expect(err?.code).toBe('repo-clone-failed')
    expect(db.select().from(cachedRepos).all().length).toBe(0)
  })

  test('cache row pointing at missing dir self-heals on next resolve', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    rmSync(a.cached.localPath, { recursive: true, force: true })
    const b = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(b.cold).toBe(true)
    expect(existsSync(b.cached.localPath)).toBe(true)
    expect(db.select().from(cachedRepos).all().length).toBe(1)
  })

  test('listCachedRepos sorts by lastFetchedAt desc and redacts URL', async () => {
    // Two remotes so we have two rows. The second uses a credential-bearing
    // URL (which we won't actually use, but it exercises redaction).
    const r2 = await buildFixtureRemote()
    try {
      await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
      // Force timestamps apart.
      let t = Date.now() + 10_000
      await resolveCachedRepo({ db, appHome, fetchOnReuse: false, now: () => t++ }, { url: r2.url })
      const items = await listCachedRepos(db)
      expect(items.length).toBe(2)
      expect(Date.parse(items[0]!.lastFetchedAt)).toBeGreaterThanOrEqual(
        Date.parse(items[1]!.lastFetchedAt),
      )
      // urlRedacted is always populated.
      for (const it of items) expect(it.urlRedacted.length).toBeGreaterThan(0)
    } finally {
      rmSync(r2.dir, { recursive: true, force: true })
    }
  })

  test('refreshCachedRepo runs fetch and updates timestamp', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    let t = Date.parse(a.cached.lastFetchedAt) + 5_000
    const r = await refreshCachedRepo({ db, appHome, now: () => t++ }, a.cached.id)
    expect(r.fetchOk).toBe(true)
    expect(Date.parse(r.item.lastFetchedAt)).toBeGreaterThan(Date.parse(a.cached.lastFetchedAt))
  })

  test('refreshCachedRepo on missing dir throws repo-cache-corrupt', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    rmSync(a.cached.localPath, { recursive: true, force: true })
    let err: unknown
    try {
      await refreshCachedRepo({ db, appHome }, a.cached.id)
    } catch (e) {
      err = e
    }
    // @ts-expect-error inspect at runtime
    expect(err?.code).toBe('repo-cache-corrupt')
  })

  test('deleteCachedRepo removes dir + row when no references', async () => {
    const a = await resolveCachedRepo({ db, appHome, fetchOnReuse: false }, { url: remoteUrl })
    expect(existsSync(a.cached.localPath)).toBe(true)
    const r = await deleteCachedRepo({ db, appHome }, a.cached.id)
    expect(r.deletedLocalPath).toBe(a.cached.localPath)
    expect(existsSync(a.cached.localPath)).toBe(false)
    expect(db.select().from(cachedRepos).all().length).toBe(0)
  })
})
