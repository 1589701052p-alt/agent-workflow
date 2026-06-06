// RFC-085 T3 — worktree-backed call-target expansion.
//
// Wraps the pure `expandMethod` with worktree I/O: a cached, shallow class→file
// index over the whole repo (so the chain can穿透 into unchanged files) + a
// path-safe file reader. The index is cheap (regex over decl lines) and cached
// per worktree path. Best-effort by design.

import { readFile as fsReadFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { DbClient } from '@/db/client'
import type { CallTarget } from '@agent-workflow/shared'
import { getTask } from '@/services/task'
import { DomainError, NotFoundError } from '@/util/errors'
import { resolveLang } from '../lang/grammars'
import { scanClassDecls, buildClassIndex } from './classIndex'
import { expandMethod, type ExpandCtx } from './service'

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  '.next',
  'vendor',
])
const MAX_INDEX_FILES = 8000
const MAX_FILE_BYTES = 2_000_000

const _indexCache = new Map<string, Promise<Map<string, string[]>>>()

/** Tracked source files under `root` (supported extensions only), skipping
 *  common build/vendor dirs. Bounded by MAX_INDEX_FILES. */
async function listSourceFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_INDEX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (out.length >= MAX_INDEX_FILES) return
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name))
      } else if (e.isFile() && resolveLang(e.name) !== null) {
        out.push(relative(root, join(dir, e.name)))
      }
    }
  }
  await walk(root)
  return out
}

/** Build (and cache per worktree) the class→file index by shallow-scanning every
 *  source file's declaration lines. */
function classIndexFor(root: string): Promise<Map<string, string[]>> {
  const cached = _indexCache.get(root)
  if (cached !== undefined) return cached
  const built = (async (): Promise<Map<string, string[]>> => {
    const files = await listSourceFiles(root)
    const perFile: Array<{ file: string; names: string[] }> = []
    for (const f of files) {
      try {
        const src = await fsReadFile(join(root, f), 'utf8')
        if (src.length <= MAX_FILE_BYTES) perFile.push({ file: f, names: scanClassDecls(f, src) })
      } catch {
        /* skip unreadable */
      }
    }
    return buildClassIndex(perFile)
  })()
  _indexCache.set(root, built)
  return built
}

/** Drop a worktree's cached index (e.g. after it changes/GCs). */
export function invalidateCallGraphIndex(root: string): void {
  _indexCache.delete(root)
}

/** Path-safe reader: only files inside `root`. */
function makeReader(root: string): (p: string) => Promise<string | null> {
  const rootResolved = resolve(root)
  return async (p) => {
    const abs = resolve(root, p)
    if (abs !== rootResolved && !abs.startsWith(rootResolved + sep)) return null // traversal guard
    try {
      return await fsReadFile(abs, 'utf8')
    } catch {
      return null
    }
  }
}

/** Build an ExpandCtx over a worktree directory (testable seam). */
export async function worktreeExpandCtx(root: string): Promise<ExpandCtx> {
  return {
    readFile: makeReader(root),
    classIndex: await classIndexFor(root),
    grammarFor: resolveLang,
    maxBytes: MAX_FILE_BYTES,
  }
}

/** Resolve the task's worktree + expand one method's direct callees. */
export async function getCallTargets(
  db: DbClient,
  taskId: string,
  methodRef: string,
): Promise<CallTarget[]> {
  const task = await getTask(db, taskId)
  if (task === null) throw new NotFoundError('task-not-found', `task '${taskId}' not found`)
  if (!existsSync(task.worktreePath)) {
    throw new DomainError(
      'task-worktree-missing',
      `worktree '${task.worktreePath}' does not exist; cannot expand call chain`,
      410,
    )
  }
  const ctx = await worktreeExpandCtx(task.worktreePath)
  return expandMethod(methodRef, ctx)
}
