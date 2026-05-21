// Defend against path traversal: every fs read/write inside a skill must land
// strictly under the skill's root directory. ValidationError on any attempt to
// escape via `..`, absolute paths, or symlinks pointing outside.

import { realpathSync } from 'node:fs'
import { isAbsolute, normalize, resolve, sep } from 'node:path'
import { ValidationError } from '@/util/errors'

/**
 * Join `relPath` onto `root` and assert the result stays inside `root`.
 * Does NOT follow symlinks at the destination; if the file already exists and
 * is a symlink pointing outside `root`, the caller must use realpathSync.
 */
export function safeJoin(root: string, relPath: string): string {
  if (relPath.length === 0) {
    throw new ValidationError('path-empty', 'path is required')
  }
  if (isAbsolute(relPath)) {
    throw new ValidationError('path-absolute', 'path must be relative')
  }
  // RFC-054 W3-5 KNOWN_GAP fix: reject any backslash on POSIX too.
  // node:path on macOS/Linux treats `\` as a literal character, so
  // `\windows\system32` and `..\..\etc` are accepted as weird-but-
  // relative filenames. That's semantically safe on POSIX-only
  // deployments today, but it's a portability landmine for future
  // Windows binaries (where `\` IS a path separator and these would
  // be real traversals). Rejecting backslash defensively now means
  // the daemon's path-safety contract is cross-platform, and surface
  // legitimate "filenames containing backslash" attempts loudly
  // rather than silently passing them through.
  if (relPath.includes('\\')) {
    throw new ValidationError('path-backslash', 'path must not contain backslash characters')
  }
  const target = resolve(root, normalize(relPath))
  const rootResolved = resolve(root)
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep
  if (target !== rootResolved && !target.startsWith(rootPrefix)) {
    throw new ValidationError('path-traversal', 'path escapes the allowed root')
  }
  return target
}

/**
 * After resolving symlinks on an existing path, verify it still falls under
 * `root` (also realpath-resolved). Useful for read endpoints where we want to
 * follow symlinks but only within the skill.
 */
export function realpathInside(root: string, target: string): string {
  let real: string
  try {
    real = realpathSync(target)
  } catch {
    // target doesn't exist yet — caller decides if that's an error.
    return target
  }
  const rootReal = realpathSync(root)
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  if (real !== rootReal && !real.startsWith(rootPrefix)) {
    throw new ValidationError('path-traversal', 'symlink escapes the allowed root')
  }
  return real
}
