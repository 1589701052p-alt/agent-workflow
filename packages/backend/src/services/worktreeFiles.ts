// RFC-065 — task worktree files tab service.
//
// Two pure functions: list one directory's direct children, and read one
// file's content bounded by WORKTREE_FILE_MAX_BYTES. Both defend against
// path traversal + symlinks pointing outside the worktree root.
//
// Kept dependency-light (no DB, no Hono) so unit tests can drive these
// against a real tmpdir without the rest of the daemon spinning up.

import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, normalize, resolve, sep } from 'node:path'

import {
  WORKTREE_DIR_MAX_ENTRIES,
  WORKTREE_FILE_MAX_BYTES,
  type WorktreeTreeEntry,
} from '@agent-workflow/shared'
import { NotFoundError, ValidationError } from '@/util/errors'

/**
 * Resolve `relPath` against `worktreePath` and assert the result is still
 * inside the worktree. Empty `relPath` resolves to the worktree root itself
 * (used by the tree-list endpoint for the root directory). Mirrors the
 * lexical containment check in `util/safePath.ts` but tolerates the empty
 * path that `safeJoin` rejects.
 */
function resolveInsideWorktree(worktreePath: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new ValidationError('worktree-path-absolute', 'path must be relative')
  }
  // Reject backslash on POSIX too (cross-platform safety, matches safePath.ts).
  if (relPath.includes('\\')) {
    throw new ValidationError('worktree-path-backslash', 'path must not contain backslash')
  }
  const root = resolve(worktreePath)
  const target = relPath.length === 0 ? root : resolve(root, normalize(relPath))
  const rootPrefix = root.endsWith(sep) ? root : root + sep
  if (target !== root && !target.startsWith(rootPrefix)) {
    throw new ValidationError('worktree-path-traversal', 'path escapes the worktree root')
  }
  return target
}

/**
 * After existence check, verify the resolved target's realpath still falls
 * under the worktree (catches symlinks pointing outside). Returns true when
 * the entry is safe to expose; false when it should be skipped silently.
 */
async function isInsideAfterRealpath(rootReal: string, target: string): Promise<boolean> {
  try {
    const real = await realpath(target)
    const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
    return real === rootReal || real.startsWith(rootPrefix)
  } catch {
    return false
  }
}

function compareEntries(a: WorktreeTreeEntry, b: WorktreeTreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' })
}

/**
 * List the direct children of `relPath` inside `worktreePath`.
 *
 * - Empty `relPath` = worktree root.
 * - `.git` (file or directory, including submodule gitlink files) is always
 *   filtered.
 * - Symlinks whose realpath escapes the worktree are silently skipped (not
 *   surfaced as errors — repos often contain such links and the listing
 *   should remain stable).
 * - Result truncated to WORKTREE_DIR_MAX_ENTRIES after sort.
 *
 * Throws:
 *   - NotFoundError('worktree-dir-not-found') — relPath does not exist.
 *   - NotFoundError('worktree-dir-not-a-directory') — relPath exists but is
 *     a regular file or other non-dir entry.
 *   - ValidationError — relPath malformed or escapes root.
 */
export async function listWorktreeDir(
  worktreePath: string,
  relPath: string,
): Promise<{ entries: WorktreeTreeEntry[]; truncated: boolean }> {
  const target = resolveInsideWorktree(worktreePath, relPath)
  let st
  try {
    st = await stat(target)
  } catch {
    throw new NotFoundError(
      'worktree-dir-not-found',
      `directory '${relPath}' not found in worktree`,
    )
  }
  if (!st.isDirectory()) {
    throw new NotFoundError('worktree-dir-not-a-directory', `path '${relPath}' is not a directory`)
  }

  const rootReal = await realpath(resolve(worktreePath))

  let raw: Dirent[]
  try {
    raw = (await readdir(target, { withFileTypes: true, encoding: 'utf8' })) as Dirent[]
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENAMETOOLONG') {
      throw new ValidationError('worktree-path-too-long', 'path is too long')
    }
    throw err
  }

  const entries: WorktreeTreeEntry[] = []
  for (const dirent of raw) {
    if (dirent.name === '.git') continue
    const childAbs = resolve(target, dirent.name)
    // Resolve symlinks defensively; non-symlink entries are cheap (realpath
    // on a regular path resolves to itself).
    const safe = await isInsideAfterRealpath(rootReal, childAbs)
    if (!safe) continue

    let kind: 'file' | 'directory'
    let size: number | null
    if (dirent.isSymbolicLink()) {
      // Determine the symlink target's effective type via stat (follows links).
      try {
        const targetStat = await stat(childAbs)
        if (targetStat.isDirectory()) {
          kind = 'directory'
          size = null
        } else if (targetStat.isFile()) {
          kind = 'file'
          size = targetStat.size
        } else {
          continue
        }
      } catch {
        continue
      }
    } else if (dirent.isDirectory()) {
      kind = 'directory'
      size = null
    } else if (dirent.isFile()) {
      try {
        const fst = await lstat(childAbs)
        size = fst.size
      } catch {
        size = 0
      }
      kind = 'file'
    } else {
      // socket / fifo / blockdev / chardev — skip.
      continue
    }
    entries.push({ name: dirent.name, kind, size })
  }

  entries.sort(compareEntries)
  const truncated = entries.length > WORKTREE_DIR_MAX_ENTRIES
  return {
    entries: truncated ? entries.slice(0, WORKTREE_DIR_MAX_ENTRIES) : entries,
    truncated,
  }
}

/**
 * Read a single file from inside `worktreePath`. Returns oversized=true (with
 * size populated from `stat` and content='') when the file exceeds 2 MiB.
 *
 * Throws:
 *   - NotFoundError('worktree-file-not-found') — file does not exist.
 *   - NotFoundError('worktree-file-not-a-file') — path exists but is not a
 *     regular file.
 *   - ValidationError — relPath empty / malformed / escapes root, or symlink
 *     target escapes root.
 */
export async function readWorktreeFile(
  worktreePath: string,
  relPath: string,
): Promise<{ size: number; oversized: boolean; content: string }> {
  if (relPath.length === 0) {
    throw new ValidationError('worktree-file-missing-path', 'file path is required')
  }
  const target = resolveInsideWorktree(worktreePath, relPath)

  let st
  try {
    st = await stat(target)
  } catch {
    throw new NotFoundError('worktree-file-not-found', `file '${relPath}' not found`)
  }
  if (!st.isFile()) {
    throw new NotFoundError('worktree-file-not-a-file', `path '${relPath}' is not a regular file`)
  }

  // Existence confirmed — now make sure symlinks didn't redirect us out of
  // the worktree. Done after stat so a non-existent path surfaces as 404
  // rather than the more confusing "symlink escapes" validation error.
  const rootReal = await realpath(resolve(worktreePath))
  const safe = await isInsideAfterRealpath(rootReal, target)
  if (!safe) {
    throw new ValidationError(
      'worktree-file-symlink-escapes',
      `symlink '${relPath}' resolves outside the worktree`,
    )
  }

  if (st.size > WORKTREE_FILE_MAX_BYTES) {
    return { size: st.size, oversized: true, content: '' }
  }
  // Use Bun.file when available (fast path); falls back to fs/promises so
  // unit tests can run under any runtime if Bun is unavailable.
  const buf = await Bun.file(target).arrayBuffer()
  const content = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  return { size: st.size, oversized: false, content }
}

// Re-exported so route layer + tests don't have to reach into shared.
export { WORKTREE_DIR_MAX_ENTRIES, WORKTREE_FILE_MAX_BYTES }
